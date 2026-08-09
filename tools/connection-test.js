const WebSocket = require('ws');

const HUB_IP = '192.168.1.3';
const PORT = '8090';

// Match the Dart client headers exactly (no Origin header)
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

console.log(`Connecting to ws://${HUB_IP}:${PORT}/bms/1/0/A/...`);

ws.on('open', function open() {
  console.log('SUCCESS: Connected to Neo Console WebSocket!');

  const payload = {
    opr: "service",
    opr_type: "service_opr",
    opr_param: "",
    record: {
      record_id: 448,
      device_name: "FAN ",
      device_type: "RL",
      app_type: "L",
      image_url: "static/image/icons/light_fan.svg",
      isFan: "false",
      is_dimmable: "false",
      device_id: "62",
      channel_id: "12",
      image_id: "10",
      device_status: "true", // Set to "false" to turn off
      delay_second: "0",
      is_tunable: "false",
      channel_id_tunable: "112",
      device_status_tunable: "false",
      is_alexa_enabled: "false",
      add_room_name: "false",
      selected_account: null,
      alexa_name: ""
    }
  };

  ws.send(JSON.stringify(payload));
  console.log('Sent control payload!');

  setTimeout(() => {
    ws.close();
    process.exit(0);
  }, 2000);
});

ws.on('message', function incoming(data) {
  console.log('Hub Response:', data.toString());
});

ws.on('error', function error(err) {
  console.error('Connection Error:', err.message);
  process.exit(1);
});