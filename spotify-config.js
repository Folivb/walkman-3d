// ==========================================
// SPOTIFY DEVELOPER CONFIGURATION
// ==========================================
// Pegar aqui el Client ID desde https://developer.spotify.com/dashboard
// El Redirect URI configurado en Spotify Dashboard debe ser: http://127.0.0.1:8080

const SPOTIFY_CLIENT_ID = '1b56200cc8f247f586330ce091b16280';

const SPOTIFY_REDIRECT_URI = window.location.origin + window.location.pathname;

const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');
