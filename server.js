const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const API_TOKEN = 'TpVIBWpqet5X8AH'; 
const APP_ID    = '1089';
const WS_URL    = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const PERIOD    = 21;
const GRANULARITY = 900; // 15 minutes in seconds
const MAX_CANDLES = 70;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

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
let lastAlertTime = {};
Object.keys(PAIRS).forEach(sym => {
    history[sym] = [];
    lastAlertTime[sym] = 0;
});

let ws;

// --- 1. EXPRESS SERVER ---
app.get('/ping', (req, res) => {
    res.status(200).send("Bot is awake and monitoring all pairs!");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- 2. TELEGRAM ALERT SYSTEM ---
async function sendTelegramAlert(symbol, price, ema) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const now = Date.now();
    if (now - lastAlertTime[symbol] < 60000) return; 

    const pairName = PAIRS[symbol];
    const msg = `🚨 *${pairName} ALERT*\n\nPrice touched the 21 EMA!\nPrice: ${price.toFixed(5)}\nEMA: ${ema.toFixed(5)}\nTimeframe: 15m`;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`;

    try {
        await fetch(url);
        console.log(`[${new Date().toLocaleTimeString()}] Alert sent to Telegram for ${pairName}!`);
        lastAlertTime[symbol] = now;
    } catch (error) {
        console.error(`Failed to send Telegram message for ${pairName}:`, error);
    }
}

// --- 3. TELEGRAM COMMAND LISTENER (/status) ---
let lastUpdateId = 0;

async function sendStatusMessage(targetChatId) {
    let statusMsg = `📊 *Live Market Status (15m)*\n\n`;
    let warmingUp = false;

    for (const sym in PAIRS) {
        const symHistory = history[sym];
        if (symHistory.length === 0) {
            warmingUp = true;
            break;
        }
        const curr = symHistory[symHistory.length - 1];
        const trend = curr.close >= curr.ema ? "📈 Bullish" : "📉 Bearish";
        statusMsg += `*${PAIRS[sym]}*: ${curr.close.toFixed(5)} (EMA: ${curr.ema.toFixed(5)}) - ${trend}\n`;
    }

    if (warmingUp) {
        statusMsg = "⏳ *Bot is currently warming up!*\nGathering historical 15m candles. Please try again in a few moments.";
    } else {
        statusMsg += `\n_Monitoring 15m timeframe 24/7.._.`;
    }
    
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${targetChatId}&text=${encodeURIComponent(statusMsg)}&parse_mode=Markdown`);
}

async function pollTelegram() {
    if (!TELEGRAM_BOT_TOKEN) return;
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=20`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.ok && data.result.length > 0) {
            for (const update of data.result) {
                lastUpdateId = update.update_id;
                const message = update.message;
                
                if (message && message.text === '/status') {
                    console.log("Status check requested via Telegram.");
                    await sendStatusMessage(message.chat.id);
                }
            }
        }
    } catch (error) {}
    pollTelegram();
}

pollTelegram();

// --- 4. TRADING LOGIC ---
function calculateAllEMA(symbol) {
    const symHistory = history[symbol];
    for (let i = 0; i < symHistory.length; i++) {
        if (i === 0) {
            symHistory[i].ema = symHistory[i].close;
        } else {
            const k = 2 / (PERIOD + 1);
            const prevEMA = symHistory[i - 1].ema;
            symHistory[i].ema = (symHistory[i].close - prevEMA) * k + prevEMA;
        }
    }
}

function checkAndLogLastTouch(symbol) {
    const symHistory = history[symbol];
    for (let i = symHistory.length - 2; i >= 0; i--) {
        const curr = symHistory[i];
        if (curr.ema && curr.low <= curr.ema && curr.high >= curr.ema) {
            const date = new Date(curr.time * 1000).toLocaleString();
            console.log(`[STARTUP CHECK] ${PAIRS[symbol]} - Last 21 EMA touch occurred at: ${date} (Price/EMA: ~${curr.ema.toFixed(5)})`);
            return; 
        }
    }
    console.log(`[STARTUP CHECK] ${PAIRS[symbol]} - No EMA touch found in the recent historical data.`);
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
            console.log("Authenticated. Fetching 15m candles for all pairs...");
            Object.keys(PAIRS).forEach(sym => {
                ws.send(JSON.stringify({ 
                    ticks_history: sym, 
                    end: 'latest', 
                    count: MAX_CANDLES,      // We only need exactly 70 candles now!
                    style: 'candles',        // Native candles instead of ticks
                    granularity: GRANULARITY, 
                    subscribe: 1 
                }));
            });
        }

        // Handle Historical Native Candles
        if (response.msg_type === 'candles') {
            const symbol = response.echo_req.ticks_history;
            if (!PAIRS[symbol]) return;

            // Map Deriv's candle array directly to our format
            history[symbol] = response.candles.map(c => ({
                time: c.epoch,
                open: parseFloat(c.open),
                high: parseFloat(c.high),
                low: parseFloat(c.low),
                close: parseFloat(c.close),
                alerted: false
            }));
            
            calculateAllEMA(symbol);
            console.log(`History compiled for ${PAIRS[symbol]}. Monitoring live 15m OHLC stream...`);
            checkAndLogLastTouch(symbol);
        }

        // Handle Live Native Candle Streams
        if (response.msg_type === 'ohlc') {
            const symbol = response.ohlc.symbol;
            if (!PAIRS[symbol]) return;

            const ohlc = response.ohlc;
            const bucket = ohlc.open_time; // The start time of the current 15m candle
            const currentPrice = parseFloat(ohlc.close);
            
            const symHistory = history[symbol];
            let lastCandle = symHistory[symHistory.length - 1];

            // Update the currently forming candle, or create a new one if 15m has passed
            if (lastCandle && lastCandle.time === bucket) {
                lastCandle.high = parseFloat(ohlc.high);
                lastCandle.low = parseFloat(ohlc.low);
                lastCandle.close = currentPrice;
            } else {
                symHistory.push({ 
                    time: bucket, 
                    open: parseFloat(ohlc.open), 
                    high: parseFloat(ohlc.high), 
                    low: parseFloat(ohlc.low), 
                    close: currentPrice, 
                    alerted: false 
                });
                if (symHistory.length > MAX_CANDLES) symHistory.shift();
                lastCandle = symHistory[symHistory.length - 1];
            }

            calculateAllEMA(symbol);

            const currentEma = lastCandle.ema;
            
            // Alert logic check
            if (lastCandle.low <= currentEma && lastCandle.high >= currentEma) {
                if (!lastCandle.alerted) {
                    sendTelegramAlert(symbol, currentPrice, currentEma);
                    lastCandle.alerted = true; // Prevents firing again on the same 15m candle
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
