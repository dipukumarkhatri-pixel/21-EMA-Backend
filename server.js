const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 1. CONFIGURATION =====
// IMPORTANT: Paste your tokens here directly!
const API_TOKEN = 'TpVIBWpqet5X8AH'; 
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_TELEGRAM_CHAT_ID';

const APP_ID = '1089';
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const PERIOD = 21;
const GRANULARITY = 900; 
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

// ===== 2. TELEGRAM CORE (Using Native Fetch) =====

async function sendTelegram(text, customChatId = null) {
    const chatId = customChatId || TELEGRAM_CHAT_ID;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}&parse_mode=Markdown`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (!data.ok) console.log(`❌ Telegram Send Failed: ${data.description}`);
    } catch (e) {
        console.error("❌ Telegram Network Error:", e.message);
    }
}

async function pollTelegram() {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                if (update.message && update.message.text === '/status') {
                    console.log(`📩 Received /status command from ${update.message.chat.id}`);
                    await sendStatusUpdate(update.message.chat.id);
                }
            }
        }
    } catch (e) { /* Timeout is normal */ }
    setTimeout(pollTelegram, 2000);
}

async function sendStatusUpdate(chatId) {
    let statusMsg = `📊 *Market Status (15m)*\n\n`;
    let warmingUp = false;

    for (const sym in PAIRS) {
        if (!history[sym] || history[sym].length < PERIOD) { warmingUp = true; break; }
        const curr = history[sym][history[sym].length - 1];
        const trend = curr.close >= curr.ema ? "🚀 Bullish" : "📉 Bearish";
        statusMsg += `*${PAIRS[sym]}*: ${curr.close.toFixed(5)} (${trend})\n`;
    }

    if (warmingUp) statusMsg = "⏳ *Bot is Warming Up*\nGathering 15m candles from Deriv. Try again in 5 minutes.";
    await sendTelegram(statusMsg, chatId);
}

// ===== 3. DERIV WS LOGIC =====

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
    console.log("🔗 Attempting to connect to Deriv...");
    const ws = new WebSocket(WS_URL);
    let pingInterval;

    ws.on('open', () => {
        console.log("✅ Deriv WebSocket Open");
        ws.send(JSON.stringify({ authorize: API_TOKEN }));
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ping: 1 }));
        }, 30000);
    });

    ws.on('message', (raw) => {
        const res = JSON.parse(raw);

        if (res.msg_type === 'authorize') {
            if (res.error) {
                console.log("❌ Auth Failed:", res.error.message);
                return;
            }
            console.log("🔓 Authenticated. Subscribing to pairs...");
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
            console.log(`📦 History Loaded for ${PAIRS[sym]}`);
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

                // Signal Logic
                if (previous.close < previous.ema && current.close > current.ema) {
                    sendTelegram(`🟢 *${PAIRS[sym]} BUY CROSS*\nPrice: ${current.close}\nEMA: ${current.ema.toFixed(5)}`);
                } else if (previous.close > previous.ema && current.close < current.ema) {
                    sendTelegram(`🔴 *${PAIRS[sym]} SELL CROSS*\nPrice: ${current.close}\nEMA: ${current.ema.toFixed(5)}`);
                }
            }
        }
    });

    ws.on('close', (code) => {
        console.log(`⚠️ Connection lost (Code ${code}). Reconnecting...`);
        clearInterval(pingInterval);
        setTimeout(connect, 5000);
    });
}

// ===== 4. BOOTUP =====

app.get('/', (req, res) => res.send("Bot is Running"));

app.listen(PORT, () => {
    console.log(`🚀 Server starting on port ${PORT}...`);
    connect();
    pollTelegram();
});
