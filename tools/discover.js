const WebSocket = require('ws');

const HUB_IP = '192.168.1.3';
const PORT = '8090';

const ws = new WebSocket(`ws://${HUB_IP}:${PORT}/bms/1/0/A/`, {
    handshakeTimeout: 5000,
    perMessageDeflate: true,
    headers: {
        'Host': `${HUB_IP}:${PORT}`,
        'User-Agent': 'Dart/3.10 (dart:io)',
        'Accept-Encoding': 'gzip',
        'Cache-Control': 'no-cache'
    }
});

ws.on('open', function open() {
    console.error('Fetching full component database from Neo Console...');

    const fetchPayload = {
        opr: "get_component",
        opr_type: "component_opr",
        opr_param: ""
    };

    ws.send(JSON.stringify(fetchPayload));
});

ws.on('message', function incoming(data) {
    try {
        const response = JSON.parse(data.toString());

        if (response.type === 'ping' || response.payload?.type === 'live_link' || response.payload?.type === 'imageMap_config') {
            return;
        }

        // Print ONLY raw JSON to standard output
        console.log(JSON.stringify(response, null, 2));

        setTimeout(() => {
            ws.close();
            process.exit(0);
        }, 1000);
    } catch (err) {
        // ignore
    }
});

ws.on('error', function error(err) {
    console.error('Error fetching components:', err.message);
    process.exit(1);
});