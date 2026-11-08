const ageConfirm = document.getElementById('age-confirm');
const start = document.getElementById('live-start');
const next = document.getElementById('live-next');
const stop = document.getElementById('live-stop');
const status = document.getElementById('live-status');
const cameraToggle = document.getElementById('camera-toggle');
const selfCamera = document.getElementById('self-camera');
const cameraPlaceholder = document.getElementById('self-camera-placeholder');

let localStream = null;

ageConfirm.addEventListener('change', () => {
  start.disabled = !ageConfirm.checked;
  status.textContent = ageConfirm.checked
    ? 'You can turn on your camera below. Stranger matching is not connected yet.'
    : 'Confirm you are 18+ to continue. Your camera will stay off until you turn it on.';
});

async function turnCameraOn() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    status.textContent = 'Camera access needs a secure HTTPS page and a browser that supports camera access.';
    return;
  }

  cameraToggle.disabled = true;
  status.textContent = 'Waiting for camera permission…';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: false
    });
    selfCamera.srcObject = localStream;
    await selfCamera.play();
    cameraPlaceholder.hidden = true;
    cameraToggle.setAttribute('aria-pressed', 'true');
    cameraToggle.innerHTML = '◉ <span>Camera off</span>';
    status.textContent = 'Your camera is on. Only your local preview is active; no video is being sent to anyone.';
  } catch (error) {
    let message = 'Could not start your camera. Check browser permissions and try again.';
    if (error && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')) {
      message = 'Camera permission was blocked. Allow camera access in your browser settings, then try again.';
    } else if (error && (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError')) {
      message = 'No camera was found on this device.';
    } else if (error && error.name === 'NotReadableError') {
      message = 'Your camera may already be in use by another app. Close it there and try again.';
    }
    status.textContent = message;
    stopLocalCamera();
  } finally {
    cameraToggle.disabled = false;
  }
}

function stopLocalCamera() {
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  selfCamera.srcObject = null;
  cameraPlaceholder.hidden = false;
  cameraToggle.setAttribute('aria-pressed', 'false');
  cameraToggle.innerHTML = '◉ <span>Camera on</span>';
}

cameraToggle.addEventListener('click', async () => {
  if (localStream) {
    stopLocalCamera();
    status.textContent = 'Your camera is off.';
  } else {
    await turnCameraOn();
  }
});

start.addEventListener('click', () => {
  status.textContent = 'Your camera preview can be turned on below. Random stranger matching and video calling are not connected yet.';
  next.disabled = true;
  stop.disabled = true;
});

next.addEventListener('click', () => {
  status.textContent = 'Stranger matching is not connected yet.';
});

stop.addEventListener('click', () => {
  status.textContent = 'No video chat session is active.';
  next.disabled = true;
  stop.disabled = true;
});

window.addEventListener('pagehide', stopLocalCamera);
