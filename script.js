const Srf = require('drachtio-srf');
const express = require('express');
const axios = require('axios');
const { createServer } = require('http');
const Retell = require('retell-sdk');
require('dotenv').config();

// --- 1. Initialization ---
const app = express();
const server = createServer(app);
const srf = new Srf();
const client = new Retell({ apiKey: process.env.RETELL_AUTH });
const logger = require('pino')({ level: process.env.LOGLEVEL || 'info' });

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration Constants
const DEFAULT_EXPIRES = 3600;
const {
    SIP_USERNAME, SIP_PASSWORD, SIP_REALM, SIP_IPV4, SIP_PORT,
    RETELL_AGENT_ID, RETELL_NUMBER,
    FB_API_VERSION, FB_PAGE_ID, FB_ACCESS_TOKEN,
    MANAGER_ID, RECEPTION_ID,
    PORT = 8080
} = process.env;

const RECIPIENT_TYPES = { event_manager: "Event Manager", recepcja: "Recepcja" };
const RECIPIENT_IDS = { event_manager: MANAGER_ID, recepcja: RECEPTION_ID };

// --- 2. Drachtio SIP Logic ---

srf.connect({
    host: '127.0.0.1',
    port: 9022,
    secret: 'cymru'
});

const aor = `sip:${SIP_USERNAME}@${SIP_REALM}`;

// Register with Provider
async function doRegister(srf) {
    try {
        const req = await srf.request(aor, {
            method: 'REGISTER',
            proxy: `sip:${SIP_IPV4}:${SIP_PORT}`,
            headers: {
                'From': aor,
                'Contact': `<sip:${aor}>;expires=${DEFAULT_EXPIRES}`,
                'Expires': DEFAULT_EXPIRES
            },
            auth: { username: SIP_USERNAME, password: SIP_PASSWORD }
        });
        req.on('response', (res) => {
            if (res.status === 200) {
                logger.info(`Successfully registered as ${aor}`);
                setTimeout(() => doRegister(srf), (DEFAULT_EXPIRES / 2) * 1000);
            }
        });
    } catch (err) {
        logger.error(`Registration failed: ${err.message}`);
        setTimeout(() => doRegister(srf), 30000);
    }
}

srf.on('connect', (err, hostport) => {
    logger.info(`Connected to drachtio at ${hostport}`);
    doRegister(srf);
});

// Handle Incoming Calls with Security Filter
srf.invite(async (req, res) => {
    const sourceIp = req.source_address;
    const callId = req.get('Call-ID');

    logger.info(`[INVITE] New call attempt. Call-ID: ${callId} from IP: ${sourceIp}`);

    // --- FIXED SECURITY CHECK ---
    // We compare against the IP (SIP_IPV4), not the Realm/Domain.
    if (sourceIp !== SIP_IPV4) {
        logger.warn(`[SECURITY] REJECTED: Source IP ${sourceIp} does not match Provider IP ${SIP_IPV4}`);
        return res.send(403, 'Forbidden');
    }

    logger.info(`[SECURITY] PASSED: Verified provider IP ${sourceIp}`);

    try {
        const from = req.callingNumber;
        logger.info(`[RETELL] Registering call with Retell... From: ${from}`);

        const phoneCallResponse = await client.call.registerPhoneCall({
            agent_id: RETELL_AGENT_ID,
            from_number: from,
            to_number: RETELL_NUMBER,
            direction: "inbound",
        });

        const sipUri = `sip:${phoneCallResponse.call_id}@sip.retellai.com`;
        logger.info(`[RETELL] Success. Call ID: ${phoneCallResponse.call_id}. Bridging...`);

        // 3. Create B2BUA
        srf.createB2BUA(req, res, sipUri, { localSdpB: req.body })
            .then(({ uas, uac }) => {
                logger.info(`[BRIDGE] Call Connected! Leg A (Provider) <-> Leg B (Retell)`);

                uas.on('destroy', () => {
                    logger.info(`[BRIDGE] Leg A terminated the call. Hanging up Leg B.`);
                    uac.destroy();
                });
                uac.on('destroy', () => {
                    logger.info(`[BRIDGE] Leg B (Retell) terminated the call. Hanging up Leg A.`);
                    uas.destroy();
                });
            })
            .catch((err) => {
                logger.error(`[BRIDGE] FAILED: ${err.message}`);
                if (!res.finalResponseSent) res.send(500);
            });
    } catch (err) {
        logger.error(`[RETELL] Registration Error: ${err.message}`);
        // If Retell fails to register the call (e.g. concurrency limit), reject the SIP call
        res.send(503, 'Service Unavailable');
    }
});

// --- 3. Messenger Webhook Logic ---

function formatFbMessage(recipientId, messageBody) {
    return {
        recipient: { id: recipientId },
        messaging_type: "MESSAGE_TAG",
        tag: "ACCOUNT_UPDATE",
        message: { text: messageBody },
        access_token: FB_ACCESS_TOKEN,
    };
}

app.post("/webhook-retell", async (req, res) => {
    const { event, call } = req.body;
    res.status(204).send(); // Acknowledge Retell immediately

    if (event === "call_analyzed" && call.from_number) {
        try {
            const fromNumber = call.from_number;
            const summary = call.call_analysis?.call_summary || "Brak podsumowania";
            const receiverType = call.call_analysis?.custom_analysis_data?.receiver_type;
            const facebookApiUrl = `https://graph.facebook.com/${FB_API_VERSION}/${FB_PAGE_ID}/messages`;

            if (RECIPIENT_IDS[receiverType]) {
                const messageBody = `📞 Numer: ${fromNumber}\n🏢 Odbiorca: ${RECIPIENT_TYPES[receiverType]}\n📝 Podsumowanie: ${summary}\n\n▶️ Nagranie: ${call.recording_url}`;

                // Send to specific recipient
                await axios.post(facebookApiUrl, formatFbMessage(RECIPIENT_IDS[receiverType], messageBody));

                // Always CC the manager if they aren't already the recipient
                if (receiverType !== "event_manager") {
                    await axios.post(facebookApiUrl, formatFbMessage(RECIPIENT_IDS["event_manager"], messageBody));
                }
                logger.info(`[SUCCESS] Messenger notification sent for ${fromNumber}`);
            }
        } catch (error) {
            logger.error("[ERROR] FB Webhook Failure:", error.response?.data || error.message);
        }
    }
});

app.get('/health', (req, res) => {
    logger.info('Health check ping received');
    res.status(200).send('<h1>Hello World!</h1><p>The server is alive and reachable via ngrok.</p>');
});

// --- 4. Start Server ---
server.listen(PORT, () => {
    logger.info(`Combined Server listening at http://localhost:${PORT}`);
});
