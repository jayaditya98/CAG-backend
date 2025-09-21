import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 8080;
const supabaseUrl = process.env.SUPABASE_URL || "https://mvxfdgmgfrgcrqvrtsaq.supabase.co";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJI-zI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im12eGZkZ21nZnJnY3JxdnJ0c2FxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg0NTIwMjUsImV4cCI6MjA3NDAyODAyNX0.y0_Ho2SmLnhmRIjkYW0tgENIORTIOm1bFDZevRwHsn8";

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// --- CONSTANTS & ENUMS (mirrored from client) ---
const STARTING_BUDGET = 10000;
const TOTAL_PLAYERS_TO_AUCTION = 60;
const ROUND_OVER_DURATION_MS = 4000;

const CricketerRole = {
  Batsman: 'Batsman',
  Bowler: 'Bowler',
  AllRounder: 'All-Rounder',
  WicketKeeper: 'Wicket-Keeper',
};

// --- IN-MEMORY STATE MANAGEMENT ---
const rooms = new Map(); // K: roomCode, V: { gameState, clients: Map<sessionId, ws> }
let cricketersMasterList = [];

// --- UTILITY FUNCTIONS ---
const shuffleArray = (array) => [...array].sort(() => Math.random() - 0.5);
const getBidIncrement = (currentBid) => {
  if (currentBid < 100) return 5;
  if (currentBid < 200) return 10;
  if (currentBid < 500) return 20;
  return 25;
};

const broadcast = (roomCode, message) => {
  const room = rooms.get(roomCode);
  if (room) {
    for (const client of room.clients.values()) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify(message));
      }
    }
  }
};

const broadcastGameState = (roomCode) => {
  const room = rooms.get(roomCode);
  if (room) {
    broadcast(roomCode, { type: 'GAME_STATE_UPDATE', payload: room.gameState });
  }
};

const sendError = (ws, message, fatal = false) => {
  ws.send(JSON.stringify({ type: 'ERROR', payload: { message, fatal } }));
};

const gameTimers = new Map(); // K: roomCode, V: { timers } to manage game loop timeouts

const clearTimersForRoom = (roomCode) => {
    const timers = gameTimers.get(roomCode);
    if (timers) {
        if (timers.roundEndTimer) clearTimeout(timers.roundEndTimer);
        if (timers.nextRoundTimer) clearTimeout(timers.nextRoundTimer);
        gameTimers.delete(roomCode);
    }
};


// --- GAME LOGIC (ported from client reducer) ---
const gameLogic = {
    DRAW_PLAYERS: (room) => {
        const { gameState } = room;
        if (cricketersMasterList.length < TOTAL_PLAYERS_TO_AUCTION) {
            gameState.lastActionMessage = `Error: Requires at least ${TOTAL_PLAYERS_TO_AUCTION} cricketers, found only ${cricketersMasterList.length}.`; return;
        }
        
        const rolePools = {
            [CricketerRole.Batsman]: shuffleArray(cricketersMasterList.filter(p => p.role === CricketerRole.Batsman)),
            [CricketerRole.Bowler]: shuffleArray(cricketersMasterList.filter(p => p.role === CricketerRole.Bowler)),
            [CricketerRole.AllRounder]: shuffleArray(cricketersMasterList.filter(p => p.role === CricketerRole.AllRounder)),
            [CricketerRole.WicketKeeper]: shuffleArray(cricketersMasterList.filter(p => p.role === CricketerRole.WicketKeeper)),
        };

        const subPools = {
            'Batters-1': rolePools[CricketerRole.Batsman].slice(0, 8), 'Batters-2': rolePools[CricketerRole.Batsman].slice(8, 17),
            'Bowlers-1': rolePools[CricketerRole.Bowler].slice(0, 7), 'Bowlers-2': rolePools[CricketerRole.Bowler].slice(7, 15),
            'All-rounders-1': rolePools[CricketerRole.AllRounder].slice(0, 6), 'All-rounders-2': rolePools[CricketerRole.AllRounder].slice(6, 13), 'All-rounders-3': rolePools[CricketerRole.AllRounder].slice(13, 20),
            'Wicket-Keepers': rolePools[CricketerRole.WicketKeeper].slice(0, 8),
        };
        
        // FIX: Use `readyForAuction` for the auction pool view and reset for all players.
        gameState.players.forEach(p => p.readyForAuction = false);
        gameState.gameStatus = 'AUCTION_POOL_VIEW';
        gameState.subPools = subPools;
        gameState.lastActionMessage = 'Player sub-pools have been drawn!';
    },
    START_GAME: (room) => {
        const { gameState } = room;
        const subPoolNames = shuffleArray(Object.keys(gameState.subPools));
        const finalAuctionPool = subPoolNames.reduce((acc, poolName) => {
            const shuffledPlayersInPool = shuffleArray(gameState.subPools[poolName]);
            return [...acc, ...shuffledPlayersInPool];
        }, []);

        gameState.gameStatus = 'AUCTION';
        gameState.auctionPool = finalAuctionPool;
        gameState.subPoolOrder = subPoolNames;
        gameState.lastActionMessage = 'Auction has started! Good luck!';
        
        // Start the first round
        gameLogic.START_NEXT_ROUND(room);
    },
    START_NEXT_ROUND: (room) => {
        const { gameState } = room;
        
        if (gameState.auctionPool.length === 0) {
            gameState.gameStatus = 'GAME_OVER';
            gameState.lastActionMessage = "The auction is over!";
            return;
        }

        const nextCricketer = gameState.auctionPool[0];
        const remainingPool = gameState.auctionPool.slice(1);
        
        let currentSubPoolName = gameState.currentSubPoolName;
        let currentSubPoolPlayers = gameState.currentSubPoolPlayers;
        if (!currentSubPoolPlayers.some(p => p.id === nextCricketer.id)) {
            for (const [name, playersInPool] of Object.entries(gameState.subPools)) {
                if (playersInPool.some(p => p.id === nextCricketer.id)) {
                    currentSubPoolName = name;
                    currentSubPoolPlayers = playersInPool;
                    break;
                }
            }
        }
        
        // Check for subpool break
        const allInCurrentPoolAuctioned = gameState.currentSubPoolPlayers.every(p => gameState.auctionHistory.some(h => h.cricketer.id === p.id));
        if (gameState.currentSubPoolName && allInCurrentPoolAuctioned && currentSubPoolName !== gameState.currentSubPoolName) {
            gameState.gameStatus = 'SUBPOOL_BREAK';
            gameState.nextSubPoolName = currentSubPoolName;
            gameState.nextSubPoolPlayers = currentSubPoolPlayers;
            gameState.lastActionMessage = `Sub-pool '${gameState.currentSubPoolName}' has ended.`;
            return;
        }

        const playersWithBudget = gameState.players.filter(p => p.budget >= nextCricketer.basePrice).map(p => p.id);
        
        if (playersWithBudget.length < 2) {
             const winner = gameState.players.find(p => p.id === playersWithBudget[0]);
             if (winner) {
                 winner.budget -= nextCricketer.basePrice;
                 winner.squad.push(nextCricketer);
                 gameState.auctionPool = remainingPool;
                 gameState.auctionHistory.push({ cricketer: nextCricketer, winningBid: nextCricketer.basePrice, winnerId: winner.id });
                 gameState.lastActionMessage = `${winner.name} wins ${nextCricketer.name} uncontested!`;
             } else {
                 // Unsold if no one can afford base price
                 gameState.auctionPool = remainingPool;
                 gameState.auctionHistory.push({ cricketer: nextCricketer, winningBid: 0, winnerId: 'UNSOLD' });
                 gameState.lastActionMessage = `${nextCricketer.name} was unsold.`;
             }
             // Immediately queue up the next round after an uncontested sale.
             const nextRoundTimer = setTimeout(() => {
                 gameLogic.START_NEXT_ROUND(room);
                 broadcastGameState(room.gameState.roomCode);
             }, 1500);
             gameTimers.set(room.gameState.roomCode, { ...gameTimers.get(room.gameState.roomCode), nextRoundTimer });
             return;
        }

        const roundOrder = [...gameState.masterBiddingOrder.slice(gameState.startingPlayerIndex), ...gameState.masterBiddingOrder.slice(0, gameState.startingPlayerIndex)];
        const activeBiddingOrder = roundOrder.filter(id => playersWithBudget.includes(id));
        
        gameState.gameStatus = 'AUCTION';
        gameState.currentPlayerForAuction = nextCricketer;
        gameState.auctionPool = remainingPool;
        gameState.currentBid = nextCricketer.basePrice;
        gameState.highestBidderId = null;
        gameState.biddingOrder = activeBiddingOrder;
        gameState.playersInRound = activeBiddingOrder;
        gameState.activePlayerId = activeBiddingOrder[0] || '';
        gameState.startingPlayerIndex = (gameState.startingPlayerIndex + 1) % gameState.masterBiddingOrder.length;
        gameState.lastActionMessage = `${nextCricketer.name} is up for auction!`;
        gameState.currentSubPoolName = currentSubPoolName;
        gameState.currentSubPoolPlayers = currentSubPoolPlayers;
    },
    PLACE_BID: (room, { sessionId }) => {
        const { gameState } = room;
        if (gameState.activePlayerId !== sessionId) return;

        const bidder = gameState.players.find(p => p.id === sessionId);
        const increment = getBidIncrement(gameState.currentBid);
        const newBid = gameState.currentBid + increment;

        if (bidder.budget < newBid) {
            gameState.lastActionMessage = `${bidder.name} doesn't have enough budget!`; return;
        }

        const currentIndex = gameState.biddingOrder.indexOf(gameState.activePlayerId);
        let nextIndex = currentIndex;
        do {
            nextIndex = (nextIndex + 1) % gameState.biddingOrder.length;
        } while (!gameState.playersInRound.includes(gameState.biddingOrder[nextIndex]));
        
        gameState.currentBid = newBid;
        gameState.highestBidderId = bidder.id;
        gameState.activePlayerId = gameState.biddingOrder[nextIndex];
        gameState.lastActionMessage = `${bidder.name} bids ${newBid}!`;

        checkRoundEnd(room);
    },
    PASS_TURN: (room, { sessionId }) => {
        const { gameState } = room;
        if (gameState.activePlayerId !== sessionId) return;

        const currentIndex = gameState.biddingOrder.indexOf(gameState.activePlayerId);
        let nextIndex = currentIndex;
        do {
            nextIndex = (nextIndex + 1) % gameState.biddingOrder.length;
        } while (!gameState.playersInRound.includes(gameState.biddingOrder[nextIndex]));

        gameState.activePlayerId = gameState.biddingOrder[nextIndex];
        gameState.lastActionMessage = `${gameState.players.find(p => p.id === sessionId)?.name} passes.`;

        checkRoundEnd(room);
    },
    DROP_FROM_ROUND: (room, { sessionId }) => {
        const { gameState } = room;
        if (!gameState.playersInRound.includes(sessionId)) return;

        gameState.playersInRound = gameState.playersInRound.filter(id => id !== sessionId);
        gameState.lastActionMessage = `${gameState.players.find(p => p.id === sessionId)?.name} has dropped.`;

        if (gameState.activePlayerId === sessionId) {
            const currentIndex = gameState.biddingOrder.indexOf(gameState.activePlayerId);
            let nextIndex = currentIndex;
            do {
                nextIndex = (nextIndex + 1) % gameState.biddingOrder.length;
            } while (gameState.playersInRound.length > 0 && !gameState.playersInRound.includes(gameState.biddingOrder[nextIndex]));
            gameState.activePlayerId = gameState.playersInRound.length > 0 ? gameState.biddingOrder[nextIndex] : '';
        }

        checkRoundEnd(room);
    },
    END_ROUND: (room) => {
        const { gameState } = room;
        const { currentPlayerForAuction, playersInRound, highestBidderId, currentBid } = gameState;
        if (!currentPlayerForAuction) return;

        let winnerId = playersInRound.length === 1 ? playersInRound[0] : highestBidderId;
        let winningBid = currentBid;
        
        if (playersInRound.length === 1 && !highestBidderId) {
            winningBid = currentPlayerForAuction.basePrice;
        }

        const winner = gameState.players.find(p => p.id === winnerId);
        if (winner && winner.budget >= winningBid) {
            winner.budget -= winningBid;
            winner.squad.push(currentPlayerForAuction);
            gameState.auctionHistory.push({ cricketer: currentPlayerForAuction, winningBid, winnerId: winner.id });
            gameState.lastActionMessage = `${winner.name} wins ${currentPlayerForAuction.name} for ${winningBid}!`;
        } else {
            // Unsold
            gameState.auctionHistory.push({ cricketer: currentPlayerForAuction, winningBid: 0, winnerId: 'UNSOLD' });
            gameState.lastActionMessage = winner ? `${winner.name} couldn't afford their bid! ${currentPlayerForAuction.name} is unsold.` : `${currentPlayerForAuction.name} was unsold.`;
        }

        gameState.gameStatus = 'ROUND_OVER';
        gameState.currentPlayerForAuction = null;

        // Schedule the next round to start after a delay
        const nextRoundTimer = setTimeout(() => {
            gameLogic.START_NEXT_ROUND(room);
            broadcastGameState(room.gameState.roomCode);
        }, ROUND_OVER_DURATION_MS);
        gameTimers.set(room.gameState.roomCode, { ...gameTimers.get(room.gameState.roomCode), nextRoundTimer });
    }
};

const checkRoundEnd = (room) => {
    const { gameState } = room;
    if (gameState.playersInRound.length <= 1) {
        clearTimersForRoom(room.gameState.roomCode);
        const roundEndTimer = setTimeout(() => {
            gameLogic.END_ROUND(room);
            broadcastGameState(room.gameState.roomCode);
        }, 1500);
        gameTimers.set(room.gameState.roomCode, { ...gameTimers.get(room.gameState.roomCode), roundEndTimer });
    }
};

// --- WEBSOCKET SERVER LOGIC ---
wss.on('connection', (ws) => {
    console.log('Client connected');
    ws.on('message', (message) => {
        try {
            const { type, payload } = JSON.parse(message);
            console.log(`Received message: ${type}`);

            // --- ROOM MANAGEMENT ---
            if (type === 'CREATE_ROOM') {
                const { sessionId, playerName } = payload;
                const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
                
                // FIX: Add readyForAuction to the player object.
                const hostPlayer = { id: sessionId, name: playerName, budget: STARTING_BUDGET, squad: [], isHost: true, isReady: true, readyForAuction: false };

                const newGameState = {
                    gameStatus: 'LOBBY',
                    roomCode,
                    players: [hostPlayer],
                    auctionPool: [],
                    subPools: {},
                    cricketersMasterList: [], // Will be loaded async
                    currentPlayerForAuction: null,
                    auctionHistory: [],
                    currentBid: 0,
                    highestBidderId: null,
                    activePlayerId: '',
                    masterBiddingOrder: [sessionId],
                    biddingOrder: [],
                    startingPlayerIndex: 0,
                    playersInRound: [],
                    lastActionMessage: 'Welcome! Share the room code to invite players.',
                    isLoading: false,
                };

                const room = {
                    gameState: newGameState,
                    clients: new Map([[sessionId, ws]])
                };
                rooms.set(roomCode, room);
                ws.sessionId = sessionId;
                ws.roomCode = roomCode;

                ws.send(JSON.stringify({ type: 'ROOM_CREATED', payload: newGameState }));
                return;
            }

            if (type === 'JOIN_ROOM') {
                const { sessionId, playerName, roomCode } = payload;
                const room = rooms.get(roomCode);
                if (!room) {
                    sendError(ws, 'Room not found.', true);
                    return;
                }
                if (room.clients.has(sessionId)){
                     // Reconnecting client
                     room.clients.set(sessionId, ws);
                } else {
                     // New client
                    if (room.gameState.players.length >= 4) {
                        sendError(ws, 'Room is full.', true); return;
                    }
                    let finalName = playerName;
                    const existingNames = new Set(room.gameState.players.map(p => p.name));
                    let suffix = 1;
                    while (existingNames.has(finalName)) {
                        finalName = `${playerName}-${suffix++}`;
                    }

                    // FIX: Add readyForAuction to the player object.
                    const newPlayer = { id: sessionId, name: finalName, budget: STARTING_BUDGET, squad: [], isHost: false, isReady: false, readyForAuction: false };
                    room.gameState.players.push(newPlayer);
                    room.gameState.masterBiddingOrder.push(sessionId);
                    room.clients.set(sessionId, ws);
                }
                
                ws.sessionId = sessionId;
                ws.roomCode = roomCode;
                
                // Send success message to joining client with the full state
                ws.send(JSON.stringify({ type: 'JOIN_SUCCESS', payload: room.gameState }));
                // Broadcast updated state to everyone else
                broadcastGameState(roomCode);
                return;
            }
            
            // --- IN-GAME ACTIONS ---
            const { roomCode, sessionId } = ws;
            const room = rooms.get(roomCode);
            if (!room) return; // Ignore messages from clients not in a room

            const player = room.gameState.players.find(p => p.id === sessionId);
            if (!player) return; // Ignore messages from non-players

            const isHost = player.isHost;

            switch(type) {
                case 'TOGGLE_READY':
                    if (room.gameState.gameStatus === 'LOBBY') {
                        player.isReady = !player.isReady;
                        broadcastGameState(roomCode);
                    }
                    break;
                case 'TOGGLE_READY_FOR_AUCTION':
                     if (room.gameState.gameStatus === 'AUCTION_POOL_VIEW') {
                        // FIX: Toggle `readyForAuction` instead of `isReady`.
                        player.readyForAuction = !player.readyForAuction;
                        broadcastGameState(roomCode);
                    }
                    break;
                case 'DRAW_PLAYERS':
                    if (isHost) {
                        gameLogic.DRAW_PLAYERS(room);
                        broadcastGameState(roomCode);
                    }
                    break;
                case 'START_GAME':
                    if (isHost) {
                        gameLogic.START_GAME(room);
                        broadcastGameState(roomCode);
                    }
                    break;
                 case 'CONTINUE_TO_NEXT_SUBPOOL':
                    if (isHost) {
                        clearTimersForRoom(roomCode);
                        gameLogic.START_NEXT_ROUND(room);
                        broadcastGameState(roomCode);
                    }
                    break;
                case 'PLACE_BID':
                    gameLogic.PLACE_BID(room, { sessionId });
                    broadcastGameState(roomCode);
                    break;
                case 'PASS_TURN':
                    gameLogic.PASS_TURN(room, { sessionId });
                    broadcastGameState(roomCode);
                    break;
                case 'DROP_FROM_ROUND':
                    gameLogic.DROP_FROM_ROUND(room, { sessionId });
                    broadcastGameState(roomCode);
                    break;
            }

        } catch (error) {
            console.error('Failed to handle message:', error);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        const { roomCode, sessionId } = ws;
        const room = rooms.get(roomCode);
        if (room) {
            room.clients.delete(sessionId);
            // Don't remove player data, allows for reconnect
            // If host disconnects, a new host should be assigned, but for now we'll keep it simple
            if (room.clients.size === 0) {
                console.log(`Room ${roomCode} is empty, deleting.`);
                clearTimersForRoom(roomCode);
                rooms.delete(roomCode);
            } else {
                 broadcastGameState(roomCode); // Notify others of disconnection (e.g., UI could show them as 'offline')
            }
        }
    });
});

const fetchCricketers = async () => {
    console.log('Fetching master cricketer list from Supabase...');
    const { data, error } = await supabase.from('cricketers').select('*');
    if (error) {
        console.error("CRITICAL: Could not fetch cricketers from Supabase.", error);
    } else if (data) {
        cricketersMasterList = data.map((item) => {
            let role = null;
            const roleStr = item.ROLE?.trim().toLowerCase();
            if (['batsman', 'batter'].includes(roleStr)) role = CricketerRole.Batsman;
            else if (roleStr === 'bowler') role = CricketerRole.Bowler;
            else if (roleStr === 'all-rounder') role = CricketerRole.AllRounder;
            else if (['wicket-keeper', 'wk'].includes(roleStr)) role = CricketerRole.WicketKeeper;
            if (!role) return null;

            return {
                id: item.id, name: item.Name, role, basePrice: item.base_price || 50, image: item.image,
                overall: item.OVR || 0, battingOVR: item['Batting OVR'] || 0,
                bowlingOVR: item['Bowling OVR'] || 0, fieldingOVR: item['Fielding OVR'] || 0,
            };
        }).filter(Boolean);
        console.log(`Successfully fetched ${cricketersMasterList.length} cricketers.`);
    }
};

server.listen(PORT, async () => {
    await fetchCricketers();
    console.log(`Server is listening on port ${PORT}`);
});