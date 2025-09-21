
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// --- Constants ---
const PORT = process.env.PORT || 8080;
const STARTING_BUDGET = 10000;
const TURN_DURATION_SECONDS = 8;
const ROUND_OVER_DURATION_MS = 4000;
const MAX_PLAYERS_PER_ROOM = 4;

// --- Supabase Setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("Supabase URL or Anon Key is missing. Make sure to set SUPABASE_URL and SUPABASE_ANON_KEY environment variables.");
  process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// --- In-Memory State ---
// This will hold all active game rooms.
// rooms = { 'ROOM_CODE': { gameState: {...}, clients: { 'sessionId': ws }, turnTimer: Timeout } }
const rooms = {};
let cricketersMasterList = [];

// --- Helper Functions ---

/**
 * Generates a random 6-character uppercase room code.
 */
const generateRoomCode = () => {
  let code;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]); // Ensure code is unique
  return code;
};

/**
 * Sends a message to all clients in a specific room.
 * @param {string} roomCode The code of the room.
 * @param {object} message The message object to send.
 */
const broadcast = (roomCode, message) => {
  const room = rooms[roomCode];
  if (!room) return;

  const messageString = JSON.stringify(message);
  for (const sessionId in room.clients) {
    const client = room.clients[sessionId];
    if (client.readyState === client.OPEN) {
      client.send(messageString);
    }
  }
};

/**
 * A more specific broadcast function for game state updates.
 * @param {string} roomCode The code of the room.
 */
const broadcastGameState = (roomCode) => {
  const room = rooms[roomCode];
  if (room && room.gameState) {
    broadcast(roomCode, {
      type: 'GAME_STATE_UPDATE',
      payload: room.gameState
    });
  }
};

/**
 * Calculates the bid increment based on the current bid amount.
 */
const getBidIncrement = (bid) => {
    if (bid < 100) return 5;
    if (bid < 200) return 10;
    if (bid < 500) return 20;
    return 25;
};

/**
 * Shuffles an array in place.
 * @param {Array} array The array to shuffle.
 */
const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
};

/**
 * Maps database-specific role names to the application's standard role names.
 * @param {string} dbRole The role name from the database (e.g., 'batter', 'wk').
 * @returns {string} The application-standard role name (e.g., 'Batsman', 'Wicket-Keeper').
 */
const mapDbRoleToGameRole = (dbRole) => {
  switch (dbRole) {
    case 'batter': return 'Batsman';
    case 'wk': return 'Wicket-Keeper';
    default: return dbRole; // Assumes 'Bowler' and 'All-Rounder' match
  }
};


// --- Core Game Logic Functions ---

/**
 * Fetches the master list of cricketers from Supabase.
 */
const fetchCricketers = async () => {
  if (cricketersMasterList.length > 0) return;
  console.log("Fetching cricketers from Supabase...");
  const { data, error } = await supabase.from('cricketers').select('*');
  if (error) {
    console.error("Error fetching cricketers:", error);
    return;
  }
  // Map Supabase columns to our Cricketer type
  cricketersMasterList = data.map(c => ({
    id: c.id,
    name: c.Name,
    role: mapDbRoleToGameRole(c.ROLE),
    basePrice: c.base_price,
    image: c.image,
    overall: c.OVR,
    battingOVR: c['Batting OVR'],
    bowlingOVR: c['Bowling OVR'],
    fieldingOVR: c['Fielding OVR'],
  }));
  console.log(`Fetched ${cricketersMasterList.length} cricketers.`);
};

/**
 * Creates the initial state for a new game.
 */
const createInitialGameState = (roomCode, hostSessionId, hostPlayerName) => {
  const hostPlayer = {
    id: hostSessionId,
    name: hostPlayerName,
    budget: STARTING_BUDGET,
    squad: [],
    isHost: true,
    isReady: true, // Host is always ready
    readyForAuction: true,
  };

  return {
    gameStatus: 'LOBBY',
    roomCode: roomCode,
    players: [hostPlayer],
    auctionPool: [],
    subPools: {},
    subPoolOrder: [],
    cricketersMasterList: [], // Will be populated by DRAW_PLAYERS
    currentPlayerForAuction: null,
    auctionHistory: [],
    currentBid: 0,
    highestBidderId: null,
    activePlayerId: '',
    masterBiddingOrder: [],
    biddingOrder: [],
    startingPlayerIndex: 0,
    playersInRound: [],
    lastActionMessage: `Room created by ${hostPlayerName}.`,
    isLoading: false,
    currentSubPoolName: '',
    currentSubPoolPlayers: [],
    nextSubPoolName: '',
    nextSubPoolPlayers: [],
  };
};

/**
 * Draws players based on specific role quotas and creates tiered sub-pools.
 */
const drawPlayersLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    // 1. Separate master list by role
    const allBatsmen = cricketersMasterList.filter(p => p.role === 'Batsman');
    const allBowlers = cricketersMasterList.filter(p => p.role === 'Bowler');
    const allAllRounders = cricketersMasterList.filter(p => p.role === 'All-Rounder');
    const allWicketKeepers = cricketersMasterList.filter(p => p.role === 'Wicket-Keeper');

    // 2. Define quotas for the 60-player pool
    const quotas = {
        Batsman: 17,
        Bowler: 15,
        'All-Rounder': 20,
        'Wicket-Keeper': 8
    };

    // 3. Check if there are enough players in the database for each role
    const errors = [];
    if (allBatsmen.length < quotas.Batsman) errors.push(`need ${quotas.Batsman} batsmen, found ${allBatsmen.length}`);
    if (allBowlers.length < quotas.Bowler) errors.push(`need ${quotas.Bowler} bowlers, found ${allBowlers.length}`);
    if (allAllRounders.length < quotas['All-Rounder']) errors.push(`need ${quotas['All-Rounder']} all-rounders, found ${allAllRounders.length}`);
    if (allWicketKeepers.length < quotas['Wicket-Keeper']) errors.push(`need ${quotas['Wicket-Keeper']} wicket-keepers, found ${allWicketKeepers.length}`);

    if (errors.length > 0) {
        const errorMessage = `Cannot draw players, insufficient numbers in database: ${errors.join(', ')}.`;
        console.error(errorMessage);
        broadcast(roomCode, { 
            type: 'ERROR', 
            payload: { message: errorMessage, fatal: false } 
        });
        room.gameState.lastActionMessage = `Error: ${errorMessage}`;
        return; // Stop the process
    }

    // 4. Shuffle each role-specific array to randomize selection
    shuffleArray(allBatsmen);
    shuffleArray(allBowlers);
    shuffleArray(allAllRounders);
    shuffleArray(allWicketKeepers);

    // 5. Select the required number of players for each role
    const selectedBatsmen = allBatsmen.slice(0, quotas.Batsman);
    const selectedBowlers = allBowlers.slice(0, quotas.Bowler);
    const selectedAllRounders = allAllRounders.slice(0, quotas['All-Rounder']);
    const selectedWicketKeepers = allWicketKeepers.slice(0, quotas['Wicket-Keeper']);

    // 6. Sort selected players by overall rating to create tiered sub-pools
    const sortByOverall = (a, b) => b.overall - a.overall;
    selectedBatsmen.sort(sortByOverall);
    selectedBowlers.sort(sortByOverall);
    selectedAllRounders.sort(sortByOverall);
    selectedWicketKeepers.sort(sortByOverall);

    // 7. Create sub-pools with specific sizes
    const subPools = {
        "Batsmen 1": selectedBatsmen.slice(0, 8),
        "Batsmen 2": selectedBatsmen.slice(8, 17),
        "Bowlers 1": selectedBowlers.slice(0, 7),
        "Bowlers 2": selectedBowlers.slice(7, 15),
        "All-Rounders 1": selectedAllRounders.slice(0, 6),
        "All-Rounders 2": selectedAllRounders.slice(6, 13),
        "All-Rounders 3": selectedAllRounders.slice(13, 20),
        "Wicket-Keepers": selectedWicketKeepers,
    };

    // 8. Define the fixed order for the auction
    const subPoolOrder = [
        "Batsmen 1",
        "Bowlers 1",
        "All-Rounders 1",
        "Wicket-Keepers",
        "Batsmen 2",
        "All-Rounders 2",
        "Bowlers 2",
        "All-Rounders 3",
    ];

    // 9. Update the main game state
    room.gameState.auctionPool = [
        ...selectedBatsmen,
        ...selectedBowlers,
        ...selectedAllRounders,
        ...selectedWicketKeepers
    ];
    room.gameState.subPools = subPools;
    room.gameState.subPoolOrder = subPoolOrder;
    room.gameState.gameStatus = 'AUCTION_POOL_VIEW';
    room.gameState.lastActionMessage = "Auction pool has been drawn!";
    
    // Reset readiness for the auction pool view
    room.gameState.players.forEach(p => {
        p.isReady = p.isHost;
        p.readyForAuction = p.isHost;
    });
};


/**
 * Starts the auction with the first player from the first sub-pool.
 */
const startAuctionLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    room.gameState.masterBiddingOrder = room.gameState.players.map(p => p.id);
    shuffleArray(room.gameState.masterBiddingOrder);
    room.gameState.startingPlayerIndex = 0;
    
    nextPlayerLogic(roomCode);
};

/**
 * Logic to bring the next player up for auction.
 */
const nextPlayerLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    if (!room.gameState.currentSubPoolName) {
        room.gameState.currentSubPoolName = room.gameState.subPoolOrder[0];
    }
    
    let currentPool = room.gameState.subPools[room.gameState.currentSubPoolName];
    
    if (!currentPool || currentPool.length === 0) {
        const currentPoolIndex = room.gameState.subPoolOrder.indexOf(room.gameState.currentSubPoolName);
        const nextPoolIndex = currentPoolIndex + 1;

        if (nextPoolIndex >= room.gameState.subPoolOrder.length) {
            room.gameState.gameStatus = 'GAME_OVER';
            room.gameState.lastActionMessage = 'The auction has concluded!';
            broadcastGameState(roomCode);
            return;
        }

        const nextPoolName = room.gameState.subPoolOrder[nextPoolIndex];
        room.gameState.gameStatus = 'SUBPOOL_BREAK';
        room.gameState.nextSubPoolName = nextPoolName;
        room.gameState.nextSubPoolPlayers = room.gameState.subPools[nextPoolName];
        room.gameState.currentSubPoolPlayers = room.gameState.subPools[room.gameState.currentSubPoolName] || [];
        broadcastGameState(roomCode);
        return;
    }

    const nextPlayer = currentPool.shift();
    room.gameState.currentPlayerForAuction = nextPlayer;
    room.gameState.currentBid = nextPlayer.basePrice;
    room.gameState.highestBidderId = null;
    room.gameState.playersInRound = room.gameState.players.filter(p => p.budget >= nextPlayer.basePrice).map(p => p.id);
    room.gameState.gameStatus = 'AUCTION';

    const masterOrder = room.gameState.masterBiddingOrder;
    const startIndex = room.gameState.startingPlayerIndex;
    room.gameState.biddingOrder = [
        ...masterOrder.slice(startIndex),
        ...masterOrder.slice(0, startIndex)
    ].filter(id => room.gameState.playersInRound.includes(id));
    
    room.gameState.activePlayerId = room.gameState.biddingOrder[0] || null;
    room.gameState.startingPlayerIndex = (startIndex + 1) % masterOrder.length;

    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = setTimeout(() => advanceTurn(roomCode, true), TURN_DURATION_SECONDS * 1000);

    broadcastGameState(roomCode);
};

/**
 * Moves to the next sub-pool after a break.
 */
const continueToNextSubPoolLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    
    const currentPoolIndex = room.gameState.subPoolOrder.indexOf(room.gameState.currentSubPoolName);
    const nextPoolName = room.gameState.subPoolOrder[currentPoolIndex + 1];

    room.gameState.currentSubPoolName = nextPoolName;
    room.gameState.nextSubPoolName = '';
    room.gameState.nextSubPoolPlayers = [];
    
    nextPlayerLogic(roomCode);
};

/**
 * Ends the bidding round for a player.
 */
const endRoundLogic = (roomCode, wasUnsold = false) => {
    const room = rooms[roomCode];
    if (!room || room.gameState.gameStatus === 'ROUND_OVER') return;
    
    if (room.turnTimer) clearTimeout(room.turnTimer);

    const { highestBidderId, currentBid, currentPlayerForAuction } = room.gameState;
    let winnerId = 'UNSOLD';
    let winningBid = 0;

    if (!wasUnsold && highestBidderId) {
        const winner = room.gameState.players.find(p => p.id === highestBidderId);
        if (winner) {
            winner.budget -= currentBid;
            winner.squad.push(currentPlayerForAuction);
            winnerId = winner.id;
            winningBid = currentBid;
            room.gameState.lastActionMessage = `${currentPlayerForAuction.name} sold to ${winner.name} for ${currentBid}!`;
        }
    } else {
        room.gameState.lastActionMessage = `${currentPlayerForAuction.name} was unsold.`;
    }

    room.gameState.auctionHistory.push({
        cricketer: currentPlayerForAuction,
        winningBid: winningBid,
        winnerId: winnerId,
    });
    
    room.gameState.gameStatus = 'ROUND_OVER';
    broadcastGameState(roomCode);

    setTimeout(() => nextPlayerLogic(roomCode), ROUND_OVER_DURATION_MS);
};

/**
 * Advances the turn to the next player.
 * @param {boolean} wasAutoPass - True if the turn advanced due to timeout.
 */
const advanceTurn = (roomCode, wasAutoPass = false) => {
    const room = rooms[roomCode];
    if (!room || room.gameState.gameStatus !== 'AUCTION') return;
    
    if (room.turnTimer) clearTimeout(room.turnTimer);

    const { biddingOrder, playersInRound } = room.gameState;
    
    if (playersInRound.length <= 1) {
        endRoundLogic(roomCode);
        return;
    }

    const currentActiveIndex = biddingOrder.indexOf(room.gameState.activePlayerId);
    
    if(wasAutoPass) {
        const timedOutPlayerId = room.gameState.activePlayerId;
        room.gameState.playersInRound = playersInRound.filter(id => id !== timedOutPlayerId);
        const timedOutPlayer = room.gameState.players.find(p=>p.id === timedOutPlayerId);
        room.gameState.lastActionMessage = `${timedOutPlayer.name} timed out and dropped from the round.`;
        if (room.gameState.playersInRound.length <= 1) {
            endRoundLogic(roomCode);
            return;
        }
    }

    let nextIndex = (currentActiveIndex + 1) % biddingOrder.length;
    while (!room.gameState.playersInRound.includes(biddingOrder[nextIndex])) {
        nextIndex = (nextIndex + 1) % biddingOrder.length;
    }
    
    room.gameState.activePlayerId = biddingOrder[nextIndex];

    room.turnTimer = setTimeout(() => advanceTurn(roomCode, true), TURN_DURATION_SECONDS * 1000);
    
    broadcastGameState(roomCode);
};


// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let userSessionId = null;
  let userRoomCode = null;

  ws.on('message', (message) => {
    try {
        const { type, payload } = JSON.parse(message);

        switch (type) {
          case 'CREATE_ROOM': {
            const roomCode = generateRoomCode();
            const { sessionId, playerName } = payload;
            
            userSessionId = sessionId;
            userRoomCode = roomCode;

            rooms[roomCode] = {
              gameState: createInitialGameState(roomCode, sessionId, playerName),
              clients: { [sessionId]: ws },
              turnTimer: null,
            };
            
            console.log(`Room ${roomCode} created by ${playerName} (${sessionId})`);
            ws.send(JSON.stringify({ type: 'ROOM_CREATED', payload: rooms[roomCode].gameState }));
            break;
          }
          
          case 'JOIN_ROOM': {
            const { roomCode, sessionId, playerName } = payload;
            const room = rooms[roomCode];
            
            if (!room) {
              ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Room not found.', fatal: true } }));
              return;
            }
            if (room.gameState.players.length >= MAX_PLAYERS_PER_ROOM) {
                ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Room is full.', fatal: true } }));
                return;
            }
            if (room.gameState.players.find(p => p.id === sessionId)) {
                // Player is rejoining, just update their websocket client
                room.clients[sessionId] = ws;
            } else {
                 const newPlayer = {
                    id: sessionId, name: playerName, budget: STARTING_BUDGET,
                    squad: [], isHost: false, isReady: false, readyForAuction: false,
                };
                room.gameState.players.push(newPlayer);
                room.gameState.lastActionMessage = `${playerName} has joined the lobby.`;
                room.clients[sessionId] = ws;
            }

            userSessionId = sessionId;
            userRoomCode = roomCode;
            
            console.log(`${playerName} (${sessionId}) joined room ${roomCode}`);
            ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', payload: room.gameState }));
            broadcastGameState(roomCode);
            break;
          }
          
          case 'DRAW_PLAYERS': {
            const room = rooms[userRoomCode];
            if (room) {
                drawPlayersLogic(userRoomCode);
                broadcastGameState(userRoomCode);
            }
            break;
          }

          case 'START_GAME': {
            const room = rooms[userRoomCode];
            if (room) startAuctionLogic(userRoomCode);
            break;
          }
          
          case 'TOGGLE_READY': {
              const room = rooms[userRoomCode];
              if (room) {
                  const player = room.gameState.players.find(p => p.id === userSessionId);
                  if (player) {
                      player.isReady = !player.isReady;
                      broadcastGameState(userRoomCode);
                  }
              }
              break;
          }
          
          case 'TOGGLE_READY_FOR_AUCTION': {
              const room = rooms[userRoomCode];
              if (room) {
                  const player = room.gameState.players.find(p => p.id === userSessionId);
                  if (player) {
                      player.readyForAuction = !player.readyForAuction;
                      broadcastGameState(userRoomCode);
                  }
              }
              break;
          }
          
          case 'PLACE_BID': {
              const room = rooms[userRoomCode];
              if (room && room.gameState.activePlayerId === userSessionId) {
                  const bidder = room.gameState.players.find(p => p.id === userSessionId);
                  const increment = getBidIncrement(room.gameState.currentBid);
                  const newBid = room.gameState.currentBid + increment;

                  if (bidder.budget >= newBid) {
                      room.gameState.currentBid = newBid;
                      room.gameState.highestBidderId = userSessionId;
                      room.gameState.lastActionMessage = `${bidder.name} bids ${newBid}!`;
                      advanceTurn(userRoomCode);
                  }
              }
              break;
          }
          
          case 'PASS_TURN': {
              const room = rooms[userRoomCode];
              if (room && room.gameState.activePlayerId === userSessionId) {
                const player = room.gameState.players.find(p => p.id === userSessionId);
                room.gameState.lastActionMessage = `${player.name} passed the turn.`;
                advanceTurn(userRoomCode);
              }
              break;
          }
          
          case 'DROP_FROM_ROUND': {
              const room = rooms[userRoomCode];
              if (room && room.gameState.activePlayerId === userSessionId) {
                  const player = room.gameState.players.find(p => p.id === userSessionId);
                  room.gameState.lastActionMessage = `${player.name} dropped from the round.`;
                  room.gameState.playersInRound = room.gameState.playersInRound.filter(id => id !== userSessionId);

                  if (room.gameState.playersInRound.length <= 1) {
                      endRoundLogic(userRoomCode);
                  } else {
                      advanceTurn(userRoomCode);
                  }
              }
              break;
          }

          case 'CONTINUE_TO_NEXT_SUBPOOL': {
            const room = rooms[userRoomCode];
            if (room) continueToNextSubPoolLogic(userRoomCode);
            break;
          }
        }
    } catch (error) {
        console.error('Failed to process message:', message, error);
    }
  });

  ws.on('close', () => {
    if (userRoomCode && userSessionId) {
      const room = rooms[userRoomCode];
      if (!room) return;
      
      delete room.clients[userSessionId];
      const disconnectedPlayer = room.gameState.players.find(p => p.id === userSessionId);
      if(!disconnectedPlayer) return;
      
      room.gameState.players = room.gameState.players.filter(p => p.id !== userSessionId);
      console.log(`Player ${disconnectedPlayer.name} disconnected from room ${userRoomCode}`);
      
      if (room.gameState.players.length === 0) {
        console.log(`Room ${userRoomCode} is empty, deleting.`);
        if (room.turnTimer) clearTimeout(room.turnTimer);
        delete rooms[userRoomCode];
      } else {
        if (disconnectedPlayer.isHost) {
            const newHost = room.gameState.players[0];
            if (newHost) {
                newHost.isHost = true;
                newHost.isReady = true;
                newHost.readyForAuction = true;
                room.gameState.lastActionMessage = `${disconnectedPlayer.name} (Host) disconnected. ${newHost.name} is the new host.`;
            }
        } else {
             room.gameState.lastActionMessage = `${disconnectedPlayer.name} has left the game.`;
        }
        broadcastGameState(userRoomCode);
      }
    }
  });
});

server.listen(PORT, async () => {
  await fetchCricketers();
  console.log(`Server is listening on http://localhost:${PORT}`);
});
