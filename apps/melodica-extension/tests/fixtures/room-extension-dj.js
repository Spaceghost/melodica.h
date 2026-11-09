import { createRoomConnection, createRoomSession, createRoomTransport } from './room-media.js';

const metadata = { track_name: 'Room oscillator', artist_name: 'Native extension fixture', release_name: 'Local', additional_info: { duration_ms: 2000 } };
let session, context, oscillator, connection, transport;
window.startRoomDj = async (id) => {
  context = new AudioContext();
  await context.resume();
  const destination = context.createMediaStreamDestination();
  oscillator = context.createOscillator();
  oscillator.frequency.value = 440;
  oscillator.connect(destination);
  oscillator.start();
  const client = {
    base: location.origin,
    token: async () => 'room-dj',
    api: async (path, options = {}) => {
      const response = await fetch('/scrobble/api/' + path.replace(/^\/+/, ''), {
        method: options.body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer room-dj', ...(options.body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: 'no-store',
      });
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.message || body.error || `HTTP ${response.status}`), { status: response.status, code: body.error });
      return body;
    },
  };
  connection = createRoomConnection({ client, id });
  transport = createRoomTransport({ connection, sfuConfigured: false, sfuAvailable: false });
  session = createRoomSession({ connection, audio: transport, player: {
    currentTrack: () => metadata,
    startTurn: async () => ({ track_metadata: metadata }),
    capture: () => destination.stream,
    pause: () => {}, resume: () => {}, setVolume: () => {}, scrobbling: () => true,
  } });
  session.addEventListener('state', (event) => { window.roomState = event.detail; });
  session.addEventListener('audio', (event) => { window.roomAudioState = event.detail; });
  session.addEventListener('error', (event) => { window.roomError = event.detail; });
  session.open();
  return true;
};
document.querySelector('#start').addEventListener('click', () => {
  window.startRoomDj(new URLSearchParams(location.search).get('id')).catch((error) => { window.roomError = { message: error.message }; });
});
