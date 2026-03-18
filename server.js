const express = require('express');
const WebSocket = require('ws');
const fetch = require('node-fetch'); // Ensure this is installed: npm install node-fetch@2

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const API_TOKEN = 'TpVIBWpqet5X8AH'; 
const TELEGRAM_BOT_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_CHAT_ID';

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

// --- 1. TELEGRAM FUNCTIONS ---

// Send Automatic Crossover Alerts
async function sendTelegramAlert(symbol, price, ema, type) {
    if (!TELEGRAM_BOT_TOKEN) return;
    const emoji = type === "BUY" ? "🟢" : "🔴";
    const msg = `${emoji} *${PAIRS[symbol]} ${type} CROSS*\n\nPrice: ${price.toFixed(5)}\nEMA: ${ema.toFixed(5)}\nTF: 15m`;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`;
    try { await fetch(url); } catch (e) { console.error("Alert Error:", e.message); }
}

// Respond to /status Command
async function sendStatusUpdate(chatId) {
    let statusMsg = `📊 *Market Status (21 EMA)*\n\n`;
    let ready = true;

    for (const sym in PAIRS) {
        const data = history[sym];
        if (data.length < PERIOD) { ready = false; break; }
        
        const curr = data[data.length - 1];
        const trend = curr.close >= curr.ema ? "🚀 Bullish" : "📉 Bearish";
        const diff = (((curr.close - curr.ema) / curr.ema) * 100).toFixed(2);
        
        statusMsg += `*${PAIRS[sym]}*: ${curr.close.toFixed(2)}\n└ ${trend} (${diff}% from EMA)\n\n`;
    }

    if (!ready) statusMsg = "⏳ *Bot is warming up...* Still collecting candle data.";
    
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(statusMsg)}&parse_mode=Markdown`;
    try { await fetch(url); } catch (e) { console.error("Status Reply Error:", e.message); }
}

// Polling for Telegram Commands
async function pollTelegram() {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`;
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                if (update.message && update.message.text === '/status') {
                    await sendStatusUpdate(update.message.chat.id);
                }
            }
        }
    } catch (e) { /* Silent fail for polling */ }
    setTimeout(pollTelegram, 3000);
}

// --- 2. LOGIC & CONNECTION ---

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
    
    ws.on('open', () => {
        console.log("Connected to Deriv.");
        ws.send(JSON.stringify({ authorize: API_TOKEN }));
        setInterval(() => { if(ws.readyState === 1) ws.send(JSON.stringify({ping:1})); }, 30000);
    });

    ws.on('message', (raw) => {
        const res = JSON.parse(raw);

        if (res.msg_type === 'authorize') {
            Object.keys(PAIRS).forEach(sym => {
                ws.send(JSON.stringify({ ticks_history: sym, count: MAX_CANDLES, style: 'candles', granularity: GRANULARITY, subscribe: 1 }));
            });
        }

        if (res.msg_type === 'candles') {
            const sym = res.echo_req.ticks_history;
            history[sym] = res.candles.map(c => ({ time: c.epoch, close: parseFloat(c.close) }));
            calculateEMA(sym);
            console.log(`Loaded ${PAIRS[sym]}`);
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

                if (previous.close < previous.ema && current.close > current.ema) {
                    sendTelegramAlert(sym, current.close, current.ema, "BUY");
                } else if (previous.close > previous.ema && current.close < current.ema) {
                    sendTelegramAlert(sym, current.close, current.ema, "SELL");
                }
            }
        }
    });

    ws.on('close', () => setTimeout(connect, 5000));
}

// Start everything
app.listen(PORT, () => console.log(`Bot Running on Port ${PORT}`));
connect();
pollTelegram();
