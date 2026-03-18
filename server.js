const WebSocket = require('ws');
const express = require('express');

// ===== CONFIG =====
const API_TOKEN = 'YOUR_DERIV_TOKEN';
const TELEGRAM_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const CHAT_ID = 'YOUR_CHAT_ID';

// All 7 of your original symbols restored
const SYMBOLS = [
    "BTCUSD",
    "EURUSD",
    "GBPUSD",
    "EURAUD",
    "AUDCAD",
    "USDCAD",
    "AUDJPY"
];

const TIMEFRAME = 60; // 1 minute for fast testing
const EMA_PERIOD = 5;  // Short EMA for frequent signals

// ===== STORAGE =====
let history = {};
let lastAlertTime = {};

// ===== EXPRESS SERVER =====
const app = express();
app.get('/ping', (req, res) => res.send("Bot Active"));
app.listen(3000, () => console.log("🚀 Server started. Monitoring 7 pairs..."));

// ===== TELEGRAM ALERT =====
async function sendTelegramAlert(symbol, price, emaValue, type) {
    const emoji = type === "BUY" ? "🟢" : "🔴";
    const message = `${emoji} ${symbol} ${type} SIGNAL\n\nPrice: ${price}\nEMA(${EMA_PERIOD}): ${emaValue.toFixed(5)}\nTime: ${new Date().toLocaleTimeString()}`;

    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: CHAT_ID, text: message })
        });
        console.log(`📡 Telegram Sent: ${symbol} ${type}`);
    } catch (err) {
        console.error("❌ Telegram Error:", err.message);
    }
}

// ===== EMA CALCULATION =====
function calculateEMA(closes) {
    const k = 2 / (EMA_PERIOD + 1);
    let emaArray = [closes[0]]; 
    for (let i = 1; i < closes.length; i++) {
        emaArray.push((closes[i] - emaArray[i - 1]) * k + emaArray[i - 1]);
    }
    return emaArray;
}

// ===== MAIN CONNECTION =====
function connect() {
    const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');
    let pingInterval;

    ws.on('open', () => {
        console.log("✅ Connected to Deriv API");
        ws.send(JSON.stringify({ authorize: API_TOKEN }));
        pingInterval = setInterval(() => ws.send(JSON.stringify({ ping: 1 })), 30000);
    });

    ws.on('message', (msg) => {
        const data = JSON.parse(msg);

        if (data.msg_type === "authorize") {
            SYMBOLS.forEach(symbol => {
                ws.send(JSON.stringify({
                    ticks_history: symbol,
                    count: 50,
                    end: "latest",
                    granularity: TIMEFRAME,
                    style: "candles",
                    subscribe: 1
                }));
            });
        }

        if (data.msg_type === "ohlc") {
            const symbol = data.echo_req.ticks_history;
            const candle = data.ohlc;

            if (!history[symbol]) history[symbol] = [];

            if (candle.is_closed) {
                const currentPrice = parseFloat(candle.close);
                history[symbol].push({ close: currentPrice });
                if (history[symbol].length > 50) history[symbol].shift();

                const closes = history[symbol].map(c => c.close);
                if (closes.length < EMA_PERIOD + 2) return;

                const emaValues = calculateEMA(closes);
                const lastEMA = emaValues[emaValues.length - 1];
                const prevEMA = emaValues[emaValues.length - 2];
                const prevClose = closes[closes.length - 2];

                // --- TERMINAL LOGGING ---
                console.log(`[${symbol}] Price: ${currentPrice} | EMA: ${lastEMA.toFixed(5)}`);

                // --- SIGNAL LOGIC ---
                if (prevClose > prevEMA && currentPrice < lastEMA) {
                    sendTelegramAlert(symbol, currentPrice, lastEMA, "SELL");
                } else if (prevClose < prevEMA && currentPrice > lastEMA) {
                    sendTelegramAlert(symbol, currentPrice, lastEMA, "BUY");
                }
            }
        }

        if (data.msg_type === "candles") {
            const symbol = data.echo_req.ticks_history;
            history[symbol] = data.candles.map(c => ({ close: parseFloat(c.close) }));
            console.log(`📦 Loaded History: ${symbol}`);
        }
    });

    ws.on('close', () => {
        console.log("⚠️ Disconnected. Reconnecting...");
        clearInterval(pingInterval);
        setTimeout(connect, 5000);
    });

    ws.on('error', () => ws.close());
}

connect();
