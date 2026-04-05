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
const TF = 900;

// ===== TELEGRAM =====
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let lastUpdateId = 0;
let lastAlertTime = {};

// ===== DATA =====
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

// ===== BUILD CANDLES FROM TICKS =====
function buildFromTicks(prices, times) {
    let temp = {};

    for (let i = 0; i < prices.length; i++) {
        let price = prices[i];
        let epoch = times[i];
        let bucket = Math.floor(epoch / TF);

        if (!temp[bucket]) {
            temp[bucket] = {
                open: price,
                high: price,
                low: price,
                close: price,
                bucket,
                ema: null
            };
        } else {
            temp[bucket].high = Math.max(temp[bucket].high, price);
            temp[bucket].low = Math.min(temp[bucket].low, price);
            temp[bucket].close = price;
        }
    }

    return Object.values(temp).slice(-70);
}

// ===== LOAD HISTORY =====
async function loadHistory(ws, symbol) {
    return new Promise((resolve) => {

        ws.send(JSON.stringify({
            ticks_history: symbol,
            adjust_start_time: 1,
            count: 200,
            end: "latest",
            granularity: TF,
            style: "candles"
        }));

        ws.once("message", (msg) => {
            try {
                const data = JSON.parse(msg);
                const obj = market[symbol];

                if (data.candles) {
                    obj.candles = data.candles.map(c => ({
                        open: c.open,
                        high: c.high,
                        low: c.low,
                        close: c.close,
                        bucket: Math.floor(c.epoch / TF),
                        ema: null
                    }));
                    console.log("History loaded:", symbol);
                }
                else if (data.history) {
                    obj.candles = buildFromTicks(data.history.prices, data.history.times);
                    console.log("Built from ticks:", symbol);
                }

                // EMA
                if (obj.candles.length > 0) {
                    let closes = obj.candles.map(c => c.close);
                    let ema = EMA(closes);
                    obj.candles[obj.candles.length - 1].ema = ema;
                }

                resolve();
            } catch {
                resolve();
            }
        });

    });
}

// ===== PROCESS TICK =====
async function processTick(obj, price, epoch, symbol) {

    const bucket = Math.floor(epoch / TF);

    if (!obj.current || obj.current.bucket !== bucket) {

        if (obj.current) {
            obj.candles.push(obj.current);

            if (obj.candles.length > MAX_CANDLES)
                obj.candles.shift();

            let closes = obj.candles.map(c => c.close);
            let ema = EMA(closes);
            obj.current.ema = ema;

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

        obj.current = {
            bucket,
            open: price,
            high: price,
            low: price,
            close: price,
            ema: null
        };

    } else {
        obj.current.high = Math.max(obj.current.high, price);
        obj.current.low = Math.min(obj.current.low, price);
        obj.current.close = price;
    }
}

// ===== TELEGRAM =====
async function sendTelegram(symbol, type, price, ema) {
    if (!BOT_TOKEN || !CHAT_ID) return;

    const now = Date.now();
    if (now - lastAlertTime[symbol] < 60000) return;

    const msg = `🚨 ${PAIRS[symbol]} ${type}\nPrice: ${price.toFixed(5)}\nEMA: ${ema.toFixed(5)}\nTF: 15m`;

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${CHAT_ID}&text=${encodeURIComponent(msg)}`;

    try {
        await fetch(url);
        lastAlertTime[symbol] = now;
    } catch {}
}

// ===== WS =====
let ws;

function connect() {
    ws = new WebSocket("wss://ws.derivws.com/websockets/v3?app_id=1089");

    ws.on("open", async () => {
        console.log("Connected");

        for (let sym of SYMBOLS) {
            await loadHistory(ws, sym);

            ws.send(JSON.stringify({
                ticks: sym,
                subscribe: 1
            }));
        }
    });

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);

            if (data.msg_type !== "tick" || !data.tick) return;

            const sym = data.echo_req?.ticks;
            if (!market[sym]) return;

            await processTick(
                market[sym],
                data.tick.quote,
                data.tick.epoch,
                sym
            );

        } catch (e) {}
    });

    ws.on("close", () => {
        setTimeout(connect, 3000);
    });
}

connect();

// ===== API =====
app.get("/ping", (req, res) => res.send("Bot running 🚀"));

app.listen(PORT, () => {
    console.log("Server running on", PORT);
});

app.get("/ping", (req, res) => {
    res.send("Bot running 🚀");
});

// ===== CRASH PROTECTION =====
process.on("uncaughtException", (err) => {
    console.error("🔥 Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("⚠️ Unhandled Rejection:", err);
});
