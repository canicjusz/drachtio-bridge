const Srf = require('drachtio-srf');
require('dotenv').config()
const Retell = require('retell-sdk');
const srf = new Srf();
const client = new Retell({apiKey: process.env.RETELL_AUTH});
DEFAULT_EXPIRES = 3600;

srf.connect({
    host: '127.0.0.1', // connect to local drachtio server
    port: 9022,
    secret: 'cymru'
});

const config = {
    username: process.env.SIP_USERNAME,
    password: process.env.SIP_PASSWORD,
    sip_realm: process.env.SIP_REALM,
    ipv4: process.env.SIP_IPV4, // The IP address of your phone provider's server
    port: process.env.SIP_PORT
};

const aor = `sip:${config.username}@${config.sip_realm}`;

async function doRegister(srf) {
    try {
        const req = await srf.request(aor, {
            method: 'REGISTER',
            proxy: `sip:${config.ipv4}:${config.port}`,
            headers: {
                'From': aor,
                'Contact': `<sip:${aor}>;expires=${DEFAULT_EXPIRES}`,
                'Expires': DEFAULT_EXPIRES
            },
            auth: {
                username: config.username,
                password: config.password
            }
        });

        req.on('response', (res) => {
            if (res.status === 200) {
                console.log(`Successfully registered as ${aor}`);
                // Re-register halfway through the expiry period
                setTimeout(() => doRegister(srf), (DEFAULT_EXPIRES / 2) * 1000);
            }
        });
    } catch (err) {
        console.error(`Registration failed: ${err.message}`);
        // Retry after 30 seconds if it fails
        setTimeout(() => doRegister(srf), 30000);
    }
}

srf.on('connect', (err, hostport) => {
    console.log(`connected to a drachtio server listening on: ${hostport}`);
    doRegister(srf);
});

// 2. Handle Incoming Calls (INVITE)
srf.invite(async (req, res) => {
    const from = req.callingNumber;
    const phoneCallResponse = await client.call.registerPhoneCall({
        agent_id: process.env.RETELL_AGENT_ID,
        from_number: from, // optional
        to_number: process.env.RETELL_NUMBER, // optional
        direction: "inbound", // optional
    });

    const sipUri = `sip:${phoneCallResponse.call_id}@sip.retellai.com`
    // We received a call from the Provider (Leg A)
    console.log(`Incoming call from ${from}`);

    // 3. Create Leg B to Retell
    srf.createB2BUA(req, res, sipUri, {localSdpB: req.body})
        .then(({uas, uac}) => {
            console.log('Call connected: Provider <-> Node <-> Retell');

            // When one side hangs up, kill the other side
            uas.on('destroy', () => uac.destroy());
            uac.on('destroy', () => uas.destroy());
        })
        .catch((err) => {
            console.error('Failed to bridge call:', err);
        });
});