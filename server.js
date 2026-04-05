const WebSocket = require("ws");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const SYMBOLS = [
    "frxEURUSD",
    "frxAUDCAD",
];

const PAIRS = {
    "frxEURUSD": "EUR/USD",
    "frxAUDCAD": "AUD/CAD",
};

const PERIOD = 21;
const MAX_CANDLES = 70;
const TF = 900;

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

// ===== TELEGRAM SEND =====
async function sendTelegram(symbol, type, price, ema) {
    if (!BOT_TOKEN || !CHAT_ID) return;

    const now = Date.now();
    if (now - lastAlertTime[symbol] < 60000) return;

    const msg = `🚨 ${PAIRS[symbol]} ${type}\n\nPrice: ${price.toFixed(5)}\nEMA: ${ema.toFixed(5)}\n\nTF: 15m`;

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
        let last = data.candles[data.candles.length - 1];

        if (!last) {
            text += `${PAIRS[sym]}: loading history...\n`;
            continue;
        }

        let trend = last.close > last.ema ? "Bullish 📈" : "Bearish 📉";

        text += `${PAIRS[sym]}
Price: ${last.close.toFixed(5)}
EMA: ${last.ema.toFixed(5)}
Signal: ${data.signal}
Trend: ${trend}\n\n`;
    }

    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage?chat_id=${chatId}&text=${encodeURIComponent(text)}`);
}

// ===== TELEGRAM LISTENER =====
async function pollTelegram() {
    if (!BOT_TOKEN) return;

    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`);
        const data = await res.json();

        if (data.result && data.result.length > 0) {
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
        console.log("Connected to Deriv");

        SYMBOLS.forEach(sym => {
            // 1. Request 70 historical candles instantly
            ws.send(JSON.stringify({
                ticks_history: sym,
                adjust_start_time: 1,
                count: MAX_CANDLES + 1, // +1 because the last candle is the current unfinished one
                end: "latest",
                style: "candles",
                granularity: TF
            }));

            // 2. Subscribe to live ticks
            ws.send(JSON.stringify({
                ticks: sym,
                subscribe: 1
            }));
        });
    });

    ws.on("message", async (msg) => {
        try {
            const data = JSON.parse(msg);

            // ==========================================
            // ===== 1. HISTORICAL CANDLES HANDLER ======
            // ==========================================
            if (data.msg_type === "candles") {
                const sym = data.echo_req.ticks_history;
                const history = data.candles;
                
                if (!history || history.length === 0) return;

                const obj = market[sym];
                obj.candles = [];

                // Loop through history and build our 70-candle box
                for (let i = 0; i < history.length; i++) {
                    const c = history[i];
                    const candleObj = {
                        bucket: Math.floor(c.epoch / TF),
                        open: parseFloat(c.open),
                        high: parseFloat(c.high),
                        low: parseFloat(c.low),
                        close: parseFloat(c.close),
                        ema: null
                    };

                    obj.candles.push(candleObj);
                    
                    // Calculate historical EMA as we build the array
                    const closes = obj.candles.map(item => item.close);
                    candleObj.ema = EMA(closes);
                }

                // The very last item returned by Deriv is the CURRENT ongoing 15m candle.
                // We pop it off the historical array and set it as obj.current so live ticks can update it.
                obj.current = obj.candles.pop();

                console.log(`✅ Pre-loaded ${obj.candles.length} past candles for ${PAIRS[sym]}`);
                return; // Exit here, as this message was just history
            }

            // ==========================================
            // ===== 2. LIVE TICK HANDLER ===============
            // ==========================================
            if (data.msg_type === "tick") {
                // Safeguard against system messages
                if (!data.tick || !data.tick.quote) return;

                const sym = data.echo_req.ticks;
                const price = data.tick.quote;
                const epoch = data.tick.epoch;

                const obj = market[sym];
                const bucket = Math.floor(epoch / TF);

                // If historical data hasn't loaded yet, ignore ticks
                if (!obj.current && obj.candles.length === 0) return;

                // Check if we entered a new 15m timeframe
                if (!obj.current || obj.current.bucket !== bucket) {

                    // ===== CLOSE PREVIOUS CANDLE =====
                    if (obj.current) {
                        obj.candles.push(obj.current);

                        if (obj.candles.length > MAX_CANDLES) {
                            obj.candles.shift();
                        }

                        let closes = obj.candles.map(c => c.close);
                        let ema = EMA(closes);
                        obj.current.ema = ema;

                        if (obj.candles.length > 1) {
                            let prev = obj.candles[obj.candles.length - 2];
                            let curr = obj.candles[obj.candles.length - 1];

                            // ===== EMA CROSS LOGIC =====
                            if (prev.close < prev.ema && curr.close > curr.ema) {
                                obj.signal = "BUY 🚀";
                                await sendTelegram(sym, "BUY 🚀", curr.close, curr.ema);
                            }
                            else if (prev.close > prev.ema && curr.close < curr.ema) {
                                obj.signal = "SELL 🔻";
                                await sendTelegram(sym, "SELL 🔻", curr.close, curr.ema);
                            } else {
                                obj.signal = "WAIT";
                            }
                        }
                    }

                    // Open new candle
                    obj.current = {
                        bucket,
                        open: price,
                        high: price,
                        low: price,
                        close: price,
                        ema: null
                    };

                } else {
                    // Update current open candle
                    obj.current.high = Math.max(obj.current.high, price);
                    obj.current.low = Math.min(obj.current.low, price);
                    obj.current.close = price;
                }
            }
        } catch (error) {
            // Catch JSON parsing errors
        }
    });

    ws.on("close", () => {
        console.log("WebSocket closed. Reconnecting...");
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
    console.error("🔥 Uncaught Exception:", err);
});

process.on("unhandledRejection", (err) => {
    console.error("⚠️ Unhandled Rejection:", err);
});
