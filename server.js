const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 1. CONFIGURATION =====
// Replace these with your actual tokens
const API_TOKEN = 'TpVIBWpqet5X8AH'; 
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID';

const APP_ID = '1089';
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const PERIOD = 21;
const GRANULARITY = 900; // 15 Minutes
const MAX_CANDLES = 70;

const PAIRS = {
    'cryBTCUSD': 'BTC/USD',
    'frxEURUSD': 'EUR/USD',
    'frxGBPUSD': 'GBP/USD',
    'frxEURAUD': 'EUR/AUD',
    'frxAUDCAD': 'AUD/CAD',
    'frxUSDCAD': 'USD/CAD',
    'frxAUDJPY': 'AUD/JPY'
};

let history = {};
let lastUpdateId = 0;
Object.keys(PAIRS).forEach(sym => { history[sym] = []; });

// ===== 2. TELEGRAM CORE FUNCTIONS =====

async function sendTelegram(text, customChatId = null) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const chatId = customChatId || TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=Markdown`;
    try {
        await fetch(url);
    } catch (e) {
        console.error("Telegram Send Error:", e.message);
    }
}

async function pollTelegram() {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                if (update.message && update.message.text === '/status') {
                    console.log(`[BOT] Status requested by ${update.message.from.first_name}`);
                    await sendStatusUpdate(update.message.chat.id);
                }
            }
        }
    } catch (e) { /* Connection timeout expected */ }
    setTimeout(pollTelegram, 1000);
}

async function sendStatusUpdate(chatId) {
    let statusMsg = `📊 *Market Status (15m)*\n\n`;
    let warmingUp = false;

    for (const sym in PAIRS) {
        if (history[sym].length < PERIOD) { warmingUp = true; break; }
        const curr = history[sym][history[sym].length - 1];
        const trend = curr.close >= curr.ema ? "🚀 Bullish" : "📉 Bearish";
        statusMsg += `*${PAIRS[sym]}*: ${curr.close.toFixed(5)}\n└ ${trend} (EMA: ${curr.ema.toFixed(5)})\n\n`;
    }

    if (warmingUp) statusMsg = "⏳ *Bot is Warming Up*\nGathering 15m candles from Deriv. Please wait...";
    await sendTelegram(statusMsg, chatId);
}

// ===== 3. TRADING & MATH LOGIC =====

function calculateEMA(symbol) {
    const symHistory = history[symbol];
    const k = 2 / (PERIOD + 1);
    for (let i = 0; i < symHistory.length; i++) {
        if (i === 0) {
            symHistory[i].ema = symHistory[i].close;
        } else {
            const prevEMA = symHistory[i - 1].ema;
            symHistory[i].ema = (symHistory[i].close - prevEMA) * k + prevEMA;
        }
    }
}

function connect() {
    const ws = new WebSocket(WS_URL);
    let pingInterval;

    ws.on('open', () => {
        console.log("Connected to Deriv WebSocket");
        ws.send(JSON.stringify({ authorize: API_TOKEN }));
        // Heartbeat to prevent 1006 errors
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }));
        }, 30000);
    });

    ws.on('message', (raw) => {
        const res = JSON.parse(raw);

        if (res.msg_type === 'authorize') {
            console.log("Authenticated. Subscribing to 15m candles...");
            Object.keys(PAIRS).forEach(sym => {
                ws.send(JSON.stringify({ 
                    ticks_history: sym, 
                    count: MAX_CANDLES, 
                    style: 'candles', 
                    granularity: GRANULARITY, 
                    subscribe: 1 
                }));
            });
        }

        if (res.msg_type === 'candles') {
            const sym = res.echo_req.ticks_history;
            history[sym] = res.candles.map(c => ({ time: c.epoch, close: parseFloat(c.close) }));
            calculateEMA(sym);
            console.log(`✅ ${PAIRS[sym]} History Loaded`);
        }

        if (res.msg_type === 'ohlc') {
            const sym = res.ohlc.symbol;
            if (res.ohlc.is_closed) {
                const symHistory = history[sym];
                const newClose = parseFloat(res.ohlc.close);
                
                symHistory.push({ time: res.ohlc.open_time, close: newClose });
                if (symHistory.length > MAX_CANDLES) symHistory.shift();
                calculateEMA(sym);

                const current = symHistory[symHistory.length - 1];
                const previous = symHistory[symHistory.length - 2];

                // Crossover Detection
                if (previous.close < previous.ema && current.close > current.ema) {
                    sendTelegram(`🟢 *${PAIRS[sym]} BUY CROSS*\nPrice: ${current.close}\nEMA: ${current.ema.toFixed(5)}`);
                } else if (previous.close > previous.ema && current.close < current.ema) {
                    sendTelegram(`🔴 *${PAIRS[sym]} SELL CROSS*\nPrice: ${current.close}\nEMA: ${current.ema.toFixed(5)}`);
                }
            }
        }
    });

    ws.on('close', () => {
        console.log("Connection closed. Reconnecting in 5s...");
        clearInterval(pingInterval);
        setTimeout(connect, 5000);
    });

    ws.on('error', (e) => console.error("Deriv Error:", e.message));
}

// ===== 4. SERVER START =====

app.get('/ping', (req, res) => res.send("Bot is Alive"));

app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
    connect();      // Start Market Data
    pollTelegram(); // Start Command Listener
});
