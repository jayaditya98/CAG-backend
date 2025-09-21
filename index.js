
import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// --- Constants ---
const PORT = process.env.PORT || 8080;
const STARTING_BUDGET = 10000;
const TURN_DURATION_SECONDS = 7;
const ROUND_OVER_DURATION_MS = 5000; // Updated to 5 seconds
const PRE_ROUND_DURATION_SECONDS = 10;
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
const rooms = {};
let cricketersMasterList = [];

// --- Helper Functions ---

const generateRoomCode = () => {
  let code;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
  } while (rooms[code]);
  return code;
};

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

const broadcastGameState = (roomCode) => {
  const room = rooms[roomCode];
  if (room && room.gameState) {
    broadcast(roomCode, { type: 'GAME_STATE_UPDATE', payload: room.gameState });
  }
};

const getBidIncrement = (bid) => {
    if (bid < 100) return 5;
    if (bid < 200) return 10;
    if (bid < 500) return 20;
    return 25;
};

const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
};

const mapDbRoleToGameRole = (dbRole) => {
  if (typeof dbRole !== 'string') return 'Unknown';
  const lowerCaseRole = dbRole.toLowerCase();
  switch (lowerCaseRole) {
    case 'batter': return 'Batsman';
    case 'wk': return 'Wicket-Keeper';
    case 'bowler': return 'Bowler';
    case 'all-rounder': return 'All-Rounder';
    default: return dbRole;
  }
};

// --- Core Game Logic Functions ---

const fetchCricketers = async () => {
  if (cricketersMasterList.length > 0) return;
  console.log("Fetching cricketers from Supabase...");
  const { data, error } = await supabase.from('cricketers').select('*');
  if (error) { console.error("Error fetching cricketers:", error); return; }
  cricketersMasterList = data.map(c => ({
    id: c.id, name: c.Name, role: mapDbRoleToGameRole(c.ROLE),
    basePrice: c.base_price, image: c.image, overall: c.OVR,
    battingOVR: c['Batting OVR'], bowlingOVR: c['Bowling OVR'], fieldingOVR: c['Fielding OVR'],
  }));
  console.log(`Fetched ${cricketersMasterList.length} cricketers.`);
};

const createInitialGameState = (roomCode, hostSessionId, hostPlayerName) => ({
    gameStatus: 'LOBBY', roomCode, players: [{
        id: hostSessionId, name: hostPlayerName, budget: STARTING_BUDGET,
        squad: [], isHost: true, isReady: true, readyForAuction: true,
    }],
    auctionPool: [], subPools: {}, subPoolOrder: [], cricketersMasterList: [],
    currentPlayerForAuction: null, auctionHistory: [], currentBid: 0, highestBidderId: null,
    activePlayerId: '', masterBiddingOrder: [], biddingOrder: [], startingPlayerIndex: 0,
    playersInRound: [], lastActionMessage: `Room created by ${hostPlayerName}.`,
    isLoading: false, currentSubPoolName: '', currentSubPoolPlayers: [], nextSubPoolName: '',
    nextSubPoolPlayers: [], currentSubPoolOrderIndex: 0, currentPlayerInSubPoolIndex: -1,
    unsoldPool: [], isSecondRound: false, nextPlayerForAuction: null,
});

const drawPlayersLogic = (roomCode) => {
    // ... same logic as before
    const room = rooms[roomCode];
    if (!room) return;

    const allBatsmen = cricketersMasterList.filter(p => p.role === 'Batsman');
    const allBowlers = cricketersMasterList.filter(p => p.role === 'Bowler');
    const allAllRounders = cricketersMasterList.filter(p => p.role === 'All-Rounder');
    const allWicketKeepers = cricketersMasterList.filter(p => p.role === 'Wicket-Keeper');

    const quotas = {
        Batsman: 17, Bowler: 15, 'All-Rounder': 20, 'Wicket-Keeper': 8
    };

    const errors = [];
    if (allBatsmen.length < quotas.Batsman) errors.push(`need ${quotas.Batsman} batsmen, found ${allBatsmen.length}`);
    if (allBowlers.length < quotas.Bowler) errors.push(`need ${quotas.Bowler} bowlers, found ${allBowlers.length}`);
    if (allAllRounders.length < quotas['All-Rounder']) errors.push(`need ${quotas['All-Rounder']} all-rounders, found ${allAllRounders.length}`);
    if (allWicketKeepers.length < quotas['Wicket-Keeper']) errors.push(`need ${quotas['Wicket-Keeper']} wicket-keepers, found ${allWicketKeepers.length}`);

    if (errors.length > 0) {
        const errorMessage = `Cannot draw players, insufficient numbers in database: ${errors.join(', ')}.`;
        console.error(errorMessage);
        broadcast(roomCode, { type: 'ERROR', payload: { message: errorMessage, fatal: false } });
        room.gameState.lastActionMessage = `Error: ${errorMessage}`;
        return;
    }

    shuffleArray(allBatsmen);
    shuffleArray(allBowlers);
    shuffleArray(allAllRounders);
    shuffleArray(allWicketKeepers);

    const selectedBatsmen = allBatsmen.slice(0, quotas.Batsman);
    const selectedBowlers = allBowlers.slice(0, quotas.Bowler);
    const selectedAllRounders = allAllRounders.slice(0, quotas['All-Rounder']);
    const selectedWicketKeepers = allWicketKeepers.slice(0, quotas['Wicket-Keeper']);

    const sortByOverall = (a, b) => b.overall - a.overall;
    selectedBatsmen.sort(sortByOverall);
    selectedBowlers.sort(sortByOverall);
    selectedAllRounders.sort(sortByOverall);
    selectedWicketKeepers.sort(sortByOverall);

    const subPools = {
        "Batsmen 1": selectedBatsmen.slice(0, 8), "Batsmen 2": selectedBatsmen.slice(8, 17),
        "Bowlers 1": selectedBowlers.slice(0, 7), "Bowlers 2": selectedBowlers.slice(7, 15),
        "All-Rounders 1": selectedAllRounders.slice(0, 6), "All-Rounders 2": selectedAllRounders.slice(6, 13), "All-Rounders 3": selectedAllRounders.slice(13, 20),
        "Wicket-Keepers": selectedWicketKeepers,
    };

    const subPoolOrder = [
        "Batsmen 1", "Bowlers 1", "All-Rounders 1", "Wicket-Keepers",
        "Batsmen 2", "All-Rounders 2", "Bowlers 2", "All-Rounders 3",
    ];

    room.gameState.auctionPool = [...selectedBatsmen, ...selectedBowlers, ...selectedAllRounders, ...selectedWicketKeepers];
    room.gameState.subPools = subPools;
    room.gameState.subPoolOrder = subPoolOrder;
    room.gameState.gameStatus = 'AUCTION_POOL_VIEW';
    room.gameState.lastActionMessage = "Auction pool has been drawn!";
    
    room.gameState.players.forEach(p => {
        p.isReady = p.isHost;
        p.readyForAuction = p.isHost;
    });
};

const startAuctionLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.gameState.masterBiddingOrder = room.gameState.players.map(p => p.id);
    shuffleArray(room.gameState.masterBiddingOrder);
    room.gameState.startingPlayerIndex = 0;
    room.gameState.currentSubPoolOrderIndex = 0;
    room.gameState.currentPlayerInSubPoolIndex = -1;
    
    // Start with pre-round timer
    room.gameState.gameStatus = 'PRE_ROUND_TIMER';
    broadcastGameState(roomCode);
    setTimeout(() => nextPlayerLogic(roomCode), PRE_ROUND_DURATION_SECONDS * 1000);
};

const peekNextPlayerForAuction = (room) => {
    // This is a non-mutating version of nextPlayerLogic to find the next player
    const { currentPlayerInSubPoolIndex, currentSubPoolOrderIndex, subPoolOrder, subPools, isSecondRound, unsoldPool } = room.gameState;
    
    const nextPlayerIndex = currentPlayerInSubPoolIndex + 1;
    const currentSubPoolName = subPoolOrder[currentSubPoolOrderIndex];
    const currentPool = subPools[currentSubPoolName];

    if (!currentPool || nextPlayerIndex >= currentPool.length) {
        const nextSubPoolIndex = currentSubPoolOrderIndex + 1;
        if (nextSubPoolIndex >= subPoolOrder.length) {
            // Check if we can start an unsold round
            if (!isSecondRound && unsoldPool.length > 0) {
                 const nextUnsoldPoolName = Object.keys(subPools).find(key => key.startsWith('Unsold') && subPools[key].length > 0);
                 if (nextUnsoldPoolName) {
                     room.gameState.nextPlayerForAuction = subPools[nextUnsoldPoolName][0];
                     return;
                 }
            }
            room.gameState.nextPlayerForAuction = null; // Game is over
            return;
        }
        const nextPoolName = subPoolOrder[nextSubPoolIndex];
        const nextPool = subPools[nextPoolName];
        room.gameState.nextPlayerForAuction = nextPool?.[0] || null;
    } else {
        room.gameState.nextPlayerForAuction = currentPool[nextPlayerIndex];
    }
};

const nextPlayerLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.gameState.nextPlayerForAuction = null; // Clear peeked player

    const nextPlayerIndex = room.gameState.currentPlayerInSubPoolIndex + 1;
    const currentSubPoolIndex = room.gameState.currentSubPoolOrderIndex;
    const currentSubPoolName = room.gameState.subPoolOrder[currentSubPoolIndex];
    const currentPool = room.gameState.subPools[currentSubPoolName];

    if (!currentPool || nextPlayerIndex >= currentPool.length) {
        const nextSubPoolIndex = currentSubPoolIndex + 1;

        if (nextSubPoolIndex >= room.gameState.subPoolOrder.length) {
            if (room.gameState.isSecondRound || room.gameState.unsoldPool.length === 0) {
                room.gameState.gameStatus = 'GAME_OVER';
                room.gameState.lastActionMessage = 'The auction has concluded!';
                broadcastGameState(roomCode);
                return;
            }

            room.gameState.isSecondRound = true;
            const newSubPools = {
                "Unsold Batsmen": room.gameState.unsoldPool.filter(p => p.role === 'Batsman'),
                "Unsold Bowlers": room.gameState.unsoldPool.filter(p => p.role === 'Bowler'),
                "Unsold All-Rounders": room.gameState.unsoldPool.filter(p => p.role === 'All-Rounder'),
                "Unsold Wicket-Keepers": room.gameState.unsoldPool.filter(p => p.role === 'Wicket-Keeper'),
            };

            const finalSubPools = {};
            const finalSubPoolOrder = [];
            for (const poolName in newSubPools) {
                if (newSubPools[poolName].length > 0) {
                    finalSubPools[poolName] = newSubPools[poolName];
                    finalSubPoolOrder.push(poolName);
                }
            }
            
            if (finalSubPoolOrder.length === 0) {
                room.gameState.gameStatus = 'GAME_OVER';
                room.gameState.lastActionMessage = 'The auction has concluded! No unsold players to auction.';
                broadcastGameState(roomCode);
                return;
            }

            room.gameState.subPools = finalSubPools;
            room.gameState.subPoolOrder = finalSubPoolOrder;
            room.gameState.currentSubPoolOrderIndex = 0;
            room.gameState.currentPlayerInSubPoolIndex = -1;

            const nextPoolName = finalSubPoolOrder[0];
            room.gameState.gameStatus = 'SUBPOOL_BREAK';
            room.gameState.currentSubPoolName = currentSubPoolName;
            room.gameState.nextSubPoolName = nextPoolName;
            room.gameState.currentSubPoolPlayers = currentPool;
            room.gameState.nextSubPoolPlayers = finalSubPools[nextPoolName];
            
            room.gameState.players.forEach(p => { if (!p.isHost) p.isReady = false; });
            
            broadcastGameState(roomCode);
            return;
        }

        const nextPoolName = room.gameState.subPoolOrder[nextSubPoolIndex];
        room.gameState.gameStatus = 'SUBPOOL_BREAK';
        room.gameState.currentSubPoolName = currentSubPoolName;
        room.gameState.nextSubPoolName = nextPoolName;
        room.gameState.currentSubPoolPlayers = currentPool || [];
        room.gameState.nextSubPoolPlayers = room.gameState.subPools[nextPoolName];
        room.gameState.currentPlayerForAuction = null;
        
        room.gameState.players.forEach(p => { if (!p.isHost) p.isReady = false; });
        
        broadcastGameState(roomCode);
        return;
    }

    room.gameState.currentPlayerInSubPoolIndex = nextPlayerIndex;
    const nextPlayer = currentPool[nextPlayerIndex];

    room.gameState.currentSubPoolName = currentSubPoolName;
    room.gameState.currentPlayerForAuction = nextPlayer;
    room.gameState.currentBid = nextPlayer.basePrice;
    room.gameState.highestBidderId = null;
    room.gameState.playersInRound = room.gameState.players.filter(p => p.budget >= nextPlayer.basePrice).map(p => p.id);
    room.gameState.gameStatus = 'AUCTION';

    const masterOrder = room.gameState.masterBiddingOrder;
    const startIndex = room.gameState.startingPlayerIndex;
    room.gameState.biddingOrder = [...masterOrder.slice(startIndex), ...masterOrder.slice(0, startIndex)].filter(id => room.gameState.playersInRound.includes(id));
    
    room.gameState.activePlayerId = room.gameState.biddingOrder[0] || null;
    room.gameState.startingPlayerIndex = (startIndex + 1) % masterOrder.length;

    if (room.turnTimer) clearTimeout(room.turnTimer);
    room.turnTimer = setTimeout(() => advanceTurn(roomCode, room.gameState.activePlayerId, 'TIMEOUT'), TURN_DURATION_SECONDS * 1000);

    broadcastGameState(roomCode);
};

const continueToNextSubPoolLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    
    peekNextPlayerForAuction(room);
    room.gameState.gameStatus = 'PRE_ROUND_TIMER';
    broadcastGameState(roomCode);
    
    setTimeout(() => {
        room.gameState.currentSubPoolOrderIndex++;
        room.gameState.currentPlayerInSubPoolIndex = -1;
        room.gameState.nextSubPoolName = '';
        room.gameState.nextSubPoolPlayers = [];
        room.gameState.currentSubPoolPlayers = [];
        
        nextPlayerLogic(roomCode);
    }, PRE_ROUND_DURATION_SECONDS * 1000);
};

const endRoundLogic = (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.gameState.gameStatus === 'ROUND_OVER') return;
    
    if (room.turnTimer) clearTimeout(room.turnTimer);

    const { highestBidderId, currentBid, currentPlayerForAuction, playersInRound } = room.gameState;
    let winnerId = 'UNSOLD';
    let winningBid = 0;
    
    const potentialWinnerId = highestBidderId || (playersInRound.length === 1 ? playersInRound[0] : null);

    if (potentialWinnerId && playersInRound.includes(potentialWinnerId)) {
        const winner = room.gameState.players.find(p => p.id === potentialWinnerId);
        // A bid must have been placed for a player to be sold
        if (winner && highestBidderId) {
            winner.budget -= currentBid;
            winner.squad.push(currentPlayerForAuction);
            winnerId = winner.id;
            winningBid = currentBid;
            room.gameState.lastActionMessage = `${currentPlayerForAuction.name} sold to ${winner.name} for ${currentBid}!`;
        }
    } 

    if (winnerId === 'UNSOLD') {
        room.gameState.lastActionMessage = `${currentPlayerForAuction.name} was unsold.`;
        room.gameState.unsoldPool.push(currentPlayerForAuction);
    }

    room.gameState.auctionHistory.push({
        cricketer: currentPlayerForAuction,
        winningBid: winningBid,
        winnerId: winnerId,
    });
    
    room.gameState.gameStatus = 'ROUND_OVER';
    peekNextPlayerForAuction(room);
    broadcastGameState(roomCode);

    setTimeout(() => nextPlayerLogic(roomCode), ROUND_OVER_DURATION_MS);
};

const advanceTurn = (roomCode, actingPlayerId, actionType) => {
    const room = rooms[roomCode];
    if (!room || room.gameState.gameStatus !== 'AUCTION' || room.gameState.activePlayerId !== actingPlayerId) {
        return;
    }

    if (room.turnTimer) clearTimeout(room.turnTimer);

    const actingPlayer = room.gameState.players.find(p => p.id === actingPlayerId);

    // 1. Update state based on the action
    if (['DROP', 'TIMEOUT'].includes(actionType)) {
        room.gameState.playersInRound = room.gameState.playersInRound.filter(id => id !== actingPlayerId);
        if (actingPlayer) {
            room.gameState.lastActionMessage = `${actingPlayer.name} ${actionType === 'TIMEOUT' ? 'timed out' : 'dropped'}.`;
        }
    } else if (actionType === 'PASS') {
        if (actingPlayer) {
            room.gameState.lastActionMessage = `${actingPlayer.name} passed.`;
        }
    }

    const { playersInRound, highestBidderId, biddingOrder } = room.gameState;

    // 2. Check for round end conditions
    // Condition A: Only one or zero players are left in the round.
    if (playersInRound.length <= 1) {
        endRoundLogic(roomCode);
        return;
    }

    // 3. Find the next eligible player in the bidding order
    const currentActiveIndex = biddingOrder.indexOf(actingPlayerId);
    let nextPlayerId = null;
    
    // Loop through the order to find the next player who is still in the round.
    for (let i = 1; i <= biddingOrder.length; i++) {
        const nextIndex = (currentActiveIndex + i) % biddingOrder.length;
        const potentialNextPlayerId = biddingOrder[nextIndex];
        if (playersInRound.includes(potentialNextPlayerId)) {
            nextPlayerId = potentialNextPlayerId;
            break;
        }
    }

    // Condition B: The turn has cycled back to the current highest bidder, meaning they've won.
    if (highestBidderId && nextPlayerId === highestBidderId) {
        endRoundLogic(roomCode);
        return;
    }
    
    // Condition C (Unsold): A full circle of passes with no bid. This is tricky,
    // but the `playersInRound.length <= 1` check handles the 2-player case correctly.
    // An infinite loop is prevented because players will eventually time out or drop.

    // 4. If no end condition is met, advance to the next player's turn
    room.gameState.activePlayerId = nextPlayerId;
    room.turnTimer = setTimeout(() => advanceTurn(roomCode, nextPlayerId, 'TIMEOUT'), TURN_DURATION_SECONDS * 1000);
    broadcastGameState(roomCode);
};

// --- Server Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
    // ... same logic as before
    let userSessionId = null;
    let userRoomCode = null;

    ws.on('message', (message) => {
        try {
            const { type, payload } = JSON.parse(message);
            const room = rooms[userRoomCode];
            const player = room ? room.gameState.players.find(p => p.id === userSessionId) : null;

            if (type !== 'CREATE_ROOM' && type !== 'JOIN_ROOM' && (!room || !player)) {
                return;
            }

            switch (type) {
                case 'CREATE_ROOM': {
                    const roomCode = generateRoomCode();
                    const { sessionId, playerName } = payload;
                    userSessionId = sessionId;
                    userRoomCode = roomCode;
                    rooms[roomCode] = { gameState: createInitialGameState(roomCode, sessionId, playerName), clients: { [sessionId]: ws }, turnTimer: null, };
                    console.log(`Room ${roomCode} created by ${playerName} (${sessionId})`);
                    ws.send(JSON.stringify({ type: 'ROOM_CREATED', payload: rooms[roomCode].gameState }));
                    break;
                }
                case 'JOIN_ROOM': {
                    const { roomCode, sessionId, playerName } = payload;
                    const joinRoom = rooms[roomCode];
                    if (!joinRoom) { ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Room not found.', fatal: true } })); return; }
                    if (joinRoom.gameState.players.length >= MAX_PLAYERS_PER_ROOM) { ws.send(JSON.stringify({ type: 'ERROR', payload: { message: 'Room is full.', fatal: true } })); return; }
                    if (!joinRoom.gameState.players.find(p => p.id === sessionId)) {
                         const newPlayer = { id: sessionId, name: playerName, budget: STARTING_BUDGET, squad: [], isHost: false, isReady: false, readyForAuction: false, };
                         joinRoom.gameState.players.push(newPlayer);
                         joinRoom.gameState.lastActionMessage = `${playerName} has joined the lobby.`;
                    }
                    joinRoom.clients[sessionId] = ws;
                    userSessionId = sessionId;
                    userRoomCode = roomCode;
                    console.log(`${playerName} (${sessionId}) joined room ${roomCode}`);
                    ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', payload: joinRoom.gameState }));
                    broadcastGameState(roomCode);
                    break;
                }
                case 'DRAW_PLAYERS': { if (player.isHost) { drawPlayersLogic(userRoomCode); broadcastGameState(userRoomCode); } break; }
                case 'START_GAME': { if (player.isHost) startAuctionLogic(userRoomCode); break; }
                case 'TOGGLE_READY': { if (player) { player.isReady = !player.isReady; broadcastGameState(userRoomCode); } break; }
                case 'TOGGLE_READY_FOR_AUCTION': { if (player) { player.readyForAuction = !player.readyForAuction; broadcastGameState(userRoomCode); } break; }
                case 'PLACE_BID': {
                    if (room.gameState.activePlayerId === userSessionId) {
                        const increment = getBidIncrement(room.gameState.currentBid);
                        const newBid = room.gameState.currentBid + increment;
                        if (player.budget >= newBid) {
                            room.gameState.currentBid = newBid;
                            room.gameState.highestBidderId = userSessionId;
                            room.gameState.lastActionMessage = `${player.name} bids ${newBid}!`;
                            advanceTurn(roomCode, userSessionId, 'BID');
                        }
                    }
                    break;
                }
                case 'PASS_TURN': { if (room.gameState.activePlayerId === userSessionId) { advanceTurn(roomCode, userSessionId, 'PASS'); } break; }
                case 'DROP_FROM_ROUND': { if (room.gameState.activePlayerId === userSessionId) { advanceTurn(roomCode, userSessionId, 'DROP'); } break; }
                case 'CONTINUE_TO_NEXT_SUBPOOL': {
                    if (player.isHost) {
                        const allReady = room.gameState.players.every(p => p.isHost || p.isReady);
                        if (allReady) continueToNextSubPoolLogic(userRoomCode);
                    }
                    break;
                }
            }
        } catch (error) { console.error('Failed to process message:', message, error); }
    });

    ws.on('close', () => {
        // ... same logic as before
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
                        newHost.isHost = true; newHost.isReady = true; newHost.readyForAuction = true;
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
