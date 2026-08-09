const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');

try {
    const rawData = fs.readFileSync(path.join(DATA, 'devices.json'));
    const json = JSON.parse(rawData);
    const areas = json.payload.response.areas[0].departments[0].sub_area;

    let csvRows = [
        [
            "Room / Area",
            "Device Name",
            "Record ID",
            "App Type",
            "Device Type",
            "Device Status (Boolean)",
            "Channel ID",
            "Tunable Channel ID",
            "Device ID",
            "Is Dimmable (Boolean)",
            "Is Tunable (Boolean)",
            "Is Fan (Boolean)",
            "Is Alexa Enabled (Boolean)",
            "IP Address",
            "Port"
        ].join(",")
    ];

    areas.forEach(room => {
        const roomName = room.name.trim();
        room.components.forEach(dev => {
            const row = [
                `"${roomName}"`,
                `"${dev.device_name ? dev.device_name.trim() : ''}"`,
                dev.record_id || '',
                `"${dev.app_type || ''}"`,
                `"${dev.device_type || ''}"`,
                dev.device_status === "true" ? "TRUE" : "FALSE",
                `"${dev.channel_id || ''}"`,
                `"${dev.channel_id_tunable || ''}"`,
                `"${dev.device_id || ''}"`,
                dev.is_dimmable === "true" ? "TRUE" : "FALSE",
                dev.is_tunable === "true" ? "TRUE" : "FALSE",
                dev.isFan === "true" ? "TRUE" : "FALSE",
                dev.is_alexa_enabled === "true" ? "TRUE" : "FALSE",
                `"${dev.ip || ''}"`,
                `"${dev.port || ''}"`
            ];
            csvRows.push(row.join(","));
        });
    });

    fs.writeFileSync(path.join(DATA, 'neo_console_devices.csv'), csvRows.join("\n"));
    console.log('Successfully created neo_console_devices.csv!');

} catch (err) {
    console.error("Error reading devices.json:", err.message);
}