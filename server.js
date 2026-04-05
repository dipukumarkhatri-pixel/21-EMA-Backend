const WebSocket = require("ws");
const express = require("express");

// safer fetch
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const SYMBOLS = [
    "frxEURUSD",
    "frxAUDCAD"
];

const PAIRS = {
    "frxEURUSD": "EUR/USD",
    "frxAUDCAD": "AUD/CAD"
};

const PERIOD = 21;
const MAX_CANDLES = 70;
const TF = 900; // 15m

// ===== TELEGRAM =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let lastUpdateId = 0;
let lastAlertTime = {};

// ===== DATA STORE =====
let market = {};

SYMBOLS.forEach(sym => {
    market[sym] = {
        candles: [],
        current: null,
        signal: "WAIT"
    };
    lastAlertTime[sym] = 0;
});

// ===== EMA =====
function EMA(data) {
    let k = 2 / (PERIOD + 1);
    let ema = data[0];

    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * k + ema;
    }
    return ema;
}

// ===== TICK → CANDLE =====
async function processTick(obj, price, epoch, symbol) {

    const bucket = Math.floor(epoch / TF); // UTC

    // ===== NEW CANDLE =====
    if (!obj.current || obj.current.bucket !== bucket) {

        if (obj.current) {
            obj.candles.push(obj.current);

            if (obj.candles.length > MAX_CANDLES)
                obj.candles.shift();

            // ===== EMA =====
            let closes = obj.candles.map(c => c.close);
            let ema = EMA(closes);
            obj.current.ema = ema;

            // ===== SIGNAL =====
            if (obj.candles.length > 1) {
                let prev = obj.candles[obj.candles.length - 2];
                let curr = obj.candles[obj.candles.length - 1];

                if (prev.close < prev.ema && curr.close > curr.ema) {
                    obj.signal = "BUY 🚀";
                    await sendTelegram(symbol, "BUY 🚀", curr.close, curr.ema);
                }
                else if (prev.close > prev.ema && curr.close < curr.ema) {
                    obj.signal = "SELL 🔻";
                    await sendTelegram(symbol, "SELL 🔻", curr.close, curr.ema);
                } else {
                    obj.signal = "WAIT";
                }
            }
        }

        // ===== CREATE NEW =====
        obj.current = {
            bucket,
            open: price,
            high: price,
            low: price,
            close: price,
            ema: null
        };

    } else {
        // ===== UPDATE =====
        obj.current.high = Math.max(obj.current.high, price);
        obj.current.low = Math.min(obj.current.low, price);
        obj.current.close = price;
    }
}

// ===== TELEGRAM SEND =====
async function sendTelegram(symbol, type, price, ema) {
    if (!BOT_TOKEN || !CHAT_ID) return;

    const now = Date.now();
    if (now - lastAlertTime[symbol] < 60000) return;

    const msg = `🚨 ${PAIRS[symbol]} ${type}\n
Price: ${price.toFixed(5)}
EMA: ${ema.toFixed(5)}\n
TF: 15m`;

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(msg)}`;

    try {
        await fetch(url);
        console.log("📩 Sent:", symbol, type);
        lastAlertTime[symbol] = now;
    } catch (e) {
        console.log("Telegram error");
    }
}

// ===== TELEGRAM STATUS =====
async function sendStatus(chatId) {
    let text = "📊 LIVE STATUS (15m)\n\n";

    for (let sym of SYMBOLS) {
        let data = market[sym];

        let last = data.candles[data.candles.length - 1] || data.current;

        if (!last) {
            text += `${PAIRS[sym]}: no data\n`;
            continue;
        }

        let ema = last.ema || 0;
        let trend = ema && last.close > ema ? "Bullish 📈" : "Bearish 📉";

        text += `${PAIRS[sym]}
Price: ${last.close.toFixed(5)}
EMA: ${ema ? ema.toFixed(5) : "loading"}
Signal: ${data.signal}
Trend: ${trend}

`;
    }

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}`);
}

// ===== TELEGRAM LISTENER =====
async function pollTelegram() {
    if (!BOT_TOKEN) return;

    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`);
        const data = await res.json();

        if (data.result.length > 0) {
            for (let u of data.result) {
                lastUpdateId = u.update_id;

                if (u.message && u.message.text === "/status") {
                    sendStatus(u.message.chat.id);
                }
            }
        }
    } catch (e) {}

    setTimeout(pollTelegram, 2000);
}

pollTelegram();

// ===== WS =====
let ws;

function connect() {
    ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

    ws.on("open", () => {
        console.log("Connected");

        SYMBOLS.forEach(sym => {
            ws.send(JSON.stringify({
                ticks: sym,
                subscribe: 1
            }));
        });
    });

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.msg_type !== "tick" || !data.tick || !data.tick.quote) return;

            const sym = data.echo_req?.ticks;
            if (!sym || !market[sym]) return;

            const price = data.tick.quote;
            const epoch = data.tick.epoch;

            const obj = market[sym];

            // ✅ TICK → CANDLE
            await processTick(obj, price, epoch, sym);

        } catch (err) {
            console.error("WS Error:", err);
        }
    });

    ws.on("close", () => {
        console.log("Reconnecting...");
        setTimeout(connect, 3000);
    });

    ws.on("error", () => {});
}

connect();

// ===== API =====
app.get("/data", (req, res) => {
    res.json(market);
});

app.get("/ping", (req, res) => {
    res.send("Bot running 🚀");
});

app.listen(PORT, () => {
    console.log("Server running on", PORT);
});

// ===== CRASH PROTECTION =====
process.on("uncaughtException", (err) => {
    console.error("Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("Unhandled Rejection:", err);
});
