const ageConfirm = document.getElementById('age-confirm');
const start = document.getElementById('live-start');
const next = document.getElementById('live-next');
const stop = document.getElementById('live-stop');
const status = document.getElementById('live-status');
ageConfirm.addEventListener('change', () => {
  start.disabled = !ageConfirm.checked;
  status.textContent = ageConfirm.checked
    ? 'Thanks. This is a visual preview; camera and matching are not connected yet.'
    : 'Confirm you are 18+ to continue. Video matching is not connected yet.';
});
start.addEventListener('click', () => {
  status.textContent = 'The layout is ready, but live video matching has not been built yet. No camera or microphone has been activated.';
  next.disabled = true;
  stop.disabled = true;
});
next.addEventListener('click', () => {
  status.textContent = 'Video matching is not connected yet.';
});
stop.addEventListener('click', () => {
  status.textContent = 'No video session is active.';
  next.disabled = true;
  stop.disabled = true;
});