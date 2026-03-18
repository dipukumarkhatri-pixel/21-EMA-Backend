const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const API_TOKEN = 'TpVIBWpqet5X8AH'; 
const APP_ID    = '1089';
const WS_URL    = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const PERIOD    = 21;
const GRANULARITY = 900; // 15 minutes
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
    res.status(200).send("Bot is monitoring 15m Crossovers!");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// --- 2. TELEGRAM ALERT SYSTEM ---
async function sendTelegramAlert(symbol, price, ema, type) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

    const pairName = PAIRS[symbol];
    const emoji = type === "BUY" ? "🟢" : "🔴";
    const msg = `${emoji} *${pairName} ${type} SIGNAL*\n\nPrice has crossed the 21 EMA!\nPrice: ${price.toFixed(5)}\nEMA: ${ema.toFixed(5)}\nTimeframe: 15m`;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodeURIComponent(msg)}&parse_mode=Markdown`;

    try {
        await fetch(url);
        console.log(`[${new Date().toLocaleTimeString()}] ${type} Alert sent for ${pairName}`);
    } catch (error) {
        console.error(`Telegram Error:`, error);
    }
}

// --- 3. TELEGRAM STATUS COMMAND ---
async function sendStatusMessage(targetChatId) {
    let statusMsg = `📊 *Market Status (15m Crossover)*\n\n`;
    let warmingUp = false;

    for (const sym in PAIRS) {
        if (history[sym].length < PERIOD) { warmingUp = true; break; }
        const curr = history[sym][history[sym].length - 1];
        const trend = curr.close >= curr.ema ? "🚀 Above EMA" : "📉 Below EMA";
        statusMsg += `*${PAIRS[sym]}*: ${curr.close.toFixed(5)} - ${trend}\n`;
    }

    if (warmingUp) statusMsg = "⏳ *Warming up...* Gathering data.";
    
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${targetChatId}&text=${encodeURIComponent(statusMsg)}&parse_mode=Markdown`);
}

// --- 4. TRADING LOGIC ---
function calculateAllEMA(symbol) {
    const symHistory = history[symbol];
    const k = 2 / (PERIOD + 1);
    for (let i = 0; i < symHistory.length; i++) {
        if (i === 0) {
            symHistory[i].ema = symHistory[i].close;
        } else {
            symHistory[i].ema = (symHistory[i].close - symHistory[i - 1].ema) * k + symHistory[i - 1].ema;
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

        if (response.msg_type === 'candles') {
            const symbol = response.echo_req.ticks_history;
            history[symbol] = response.candles.map(c => ({
                time: c.epoch,
                close: parseFloat(c.close)
            }));
            calculateAllEMA(symbol);
            console.log(`History loaded for ${PAIRS[symbol]}`);
        }

        if (response.msg_type === 'ohlc') {
            const symbol = response.ohlc.symbol;
            const ohlc = response.ohlc;
            const symHistory = history[symbol];

            // Only process when a 15-minute candle officially closes
            if (ohlc.is_closed) {
                const newClose = parseFloat(ohlc.close);
                
                // Add closed candle to history
                symHistory.push({ time: ohlc.open_time, close: newClose });
                if (symHistory.length > MAX_CANDLES) symHistory.shift();

                calculateAllEMA(symbol);

                if (symHistory.length < 2) return;

                const current = symHistory[symHistory.length - 1];
                const previous = symHistory[symHistory.length - 2];

                // CROSSOVER DETECTION
                // BUY: Prev was below EMA, Current is above EMA
                if (previous.close < previous.ema && current.close > current.ema) {
                    sendTelegramAlert(symbol, current.close, current.ema, "BUY");
                } 
                // SELL: Prev was above EMA, Current is below EMA
                else if (previous.close > previous.ema && current.close < current.ema) {
                    sendTelegramAlert(symbol, current.close, current.ema, "SELL");
                }
            }
        }
    });

    ws.on('close', () => setTimeout(connect, 3000));
}

connect();
