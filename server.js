const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const API_TOKEN = 'TpVIBWpqet5X8AH'; 
const APP_ID    = '1089';
const WS_URL    = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL    = 'cryBTCUSD';
const PERIOD    = 21;
const GRANULARITY = 5; 
const MAX_CANDLES = 70;

// Pulled securely from Render Environment Variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let history = [];
let ws;
let lastAlertTime = 0; // Cooldown timer

// --- 1. EXPRESS SERVER (For Render & Cron-Job) ---
app.get('/ping', (req, res) => {
    res.status(200).send("Bot is awake and monitoring!");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- 2. TELEGRAM ALERT SYSTEM ---
async function sendTelegramAlert(price, ema) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("Alert triggered, but Telegram credentials are missing!");
        return;
    }

    const now = Date.now();
    // 60-second cooldown to prevent notification spam
    if (now - lastAlertTime < 60000) return; 

    const msg = `🚨 *BTC/USD ALERT*\n\nPrice touched the 21 EMA!\nPrice: $${price.toFixed(2)}\nEMA: $${ema.toFixed(2)}\nTimeframe: 5s`;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`;

    try {
        await fetch(url);
        console.log(`[${new Date().toLocaleTimeString()}] Alert sent to Telegram!`);
        lastAlertTime = now;
    } catch (error) {
        console.error("Failed to send Telegram message:", error);
    }
}

// --- 3. TRADING LOGIC ---
function calculateAllEMA() {
    for (let i = 0; i < history.length; i++) {
        if (i === 0) {
            history[i].ema = history[i].close;
        } else {
            const k = 2 / (PERIOD + 1);
            const prevEMA = history[i - 1].ema;
            history[i].ema = (history[i].close - prevEMA) * k + prevEMA;
        }
    }
}

function connect() {
    ws = new WebSocket(WS_URL);
    
    ws.on('open', () => {
        console.log("Connected to Deriv. Authenticating...");
        ws.send(JSON.stringify({ authorize: API_TOKEN }));
    });

    ws.on('message', (data) => {
        const response = JSON.parse(data);

        if (response.msg_type === 'authorize') {
            console.log("Authenticated. Fetching tick stream...");
            ws.send(JSON.stringify({ 
                ticks_history: SYMBOL, 
                end: 'latest', 
                count: 1000, 
                style: 'ticks', 
                subscribe: 1 
            }));
        }

        // Build historical 5s candles
        if (response.msg_type === 'history') {
            const p = response.history.prices;
            const t = response.history.times;
            const candleMap = new Map();
            
            for(let i = 0; i < p.length; i++) {
                const epoch = t[i];
                const price = p[i];
                const bucket = Math.floor(epoch / GRANULARITY) * GRANULARITY;
                
                if (!candleMap.has(bucket)) {
                    candleMap.set(bucket, { time: bucket, open: price, high: price, low: price, close: price, alerted: false });
                } else {
                    const c = candleMap.get(bucket);
                    c.high = Math.max(c.high, price);
                    c.low = Math.min(c.low, price);
                    c.close = price;
                }
            }
            
            history = Array.from(candleMap.values());
            if (history.length > MAX_CANDLES) history = history.slice(-MAX_CANDLES);
            calculateAllEMA();
            console.log("History compiled. Monitoring live 5s candles...");
        }

        // Live Tick Updates
        if (response.msg_type === 'tick') {
            const price = response.tick.quote;
            const epoch = response.tick.epoch;
            const bucket = Math.floor(epoch / GRANULARITY) * GRANULARITY;
            const lastCandle = history[history.length - 1];

            if (lastCandle && lastCandle.time === bucket) {
                lastCandle.high = Math.max(lastCandle.high, price);
                lastCandle.low = Math.min(lastCandle.low, price);
                lastCandle.close = price;
            } else {
                history.push({ time: bucket, open: price, high: price, low: price, close: price, alerted: false });
                if (history.length > MAX_CANDLES) history.shift();
            }

            calculateAllEMA();

            const currentEma = history[history.length - 1].ema;
            const curr = history[history.length - 1];
            
            // Touch condition
            if (curr.low <= currentEma && curr.high >= currentEma) {
                if (!curr.alerted) {
                    sendTelegramAlert(curr.close, currentEma);
                    curr.alerted = true;
                }
            }
        }
    });

    ws.on('close', () => {
        console.log("WebSocket disconnected. Reconnecting in 3s...");
        setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.error("WebSocket Error:", err);
    });
}

connect();
