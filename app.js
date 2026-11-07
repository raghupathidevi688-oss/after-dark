const sbConfig = window.AFTER_DARK_SUPABASE_CONFIG;
const supabaseClient = sbConfig && window.supabase?.createClient && sbConfig.url && sbConfig.publishableKey
  ? window.supabase.createClient(sbConfig.url, sbConfig.publishableKey)
  : null;
window.afterDarkSupabaseClient = supabaseClient;

const $ = (id) => document.getElementById(id);
const startButton = $('start-button');
const cancelButton = $('cancel-button');
const skipButton = $('skip-button');
const leaveButton = $('leave-button');
const chatCard = document.querySelector('.chat-card');
const emptyState = $('empty-state');
const waitingState = $('waiting-state');
const conversation = $('conversation');
const statusText = $('status-text');
const cardTitle = $('card-title');
const messageList = $('message-list');
const dialog = $('safety-dialog');
let currentRoomId = null;
let currentChannel = null;
let currentUserId = null;
let currentUsername = null;
let matchLoop = null;
let searchToken = 0;
let matchRequestInFlight = false;
let chatMode = 'one';
let reportBusy = false;
const activeRoomKey = (userId) => `after-dark-active-room:${userId}`;

function showToast(text) {
  const toast = $('toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}
function setConnectionStatus(connected) {
  $('stranger-detail').textContent = connected ? 'connected just now' : 'connection ended';
}
function createRandomUsername() {
  const first = ['Quiet', 'Cosmic', 'Velvet', 'Mellow', 'Silver', 'Midnight', 'Sunny', 'Hidden', 'Gentle', 'Lucky', 'Blue', 'Dreamy'];
  const second = ['Comet', 'Fox', 'Lantern', 'Orbit', 'Panda', 'Raven', 'Nova', 'Willow', 'Otter', 'Star', 'Cloud', 'Echo'];
  const value = new Uint32Array(3);
  if (window.crypto?.getRandomValues) window.crypto.getRandomValues(value);
  else value.set([Math.random() * 2 ** 32, Math.random() * 2 ** 32, Math.random() * 2 ** 32]);
  return `${first[value[0] % first.length]}${second[value[1] % second.length]}${1000 + (value[2] % 9000)}`;
}
async function ensureSignedIn() {
  if (!supabaseClient) throw new Error('Supabase is not configured.');
  let { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    const result = await supabaseClient.auth.signInAnonymously();
    if (result.error) throw result.error;
    session = result.data.session;
  }
  currentUserId = session.user.id;
  const usernameKey = `after-dark-random-name:${currentUserId}`;
  try {
    currentUsername = localStorage.getItem(usernameKey);
    if (!currentUsername) {
      currentUsername = createRandomUsername();
      localStorage.setItem(usernameKey, currentUsername);
    }
  } catch (_) { currentUsername = createRandomUsername(); }
}
async function recoverInterruptedChat() {
  if (!currentUserId) return;
  let previousRoomId;
  try { previousRoomId = localStorage.getItem(activeRoomKey(currentUserId)); } catch (_) { return; }
  if (!previousRoomId || previousRoomId === currentRoomId) return;
  const { error } = await supabaseClient.rpc('leave_after_dark_chat', { target_room_id: previousRoomId });
  if (error) throw error;
  try { localStorage.removeItem(activeRoomKey(currentUserId)); } catch (_) {}
}
async function loadLastChatPreview() {
  const button = $('history-button');
  if (!currentUserId) { button.classList.add('hidden'); return; }
  const { data, error } = await supabaseClient.from('after_dark_last_chat')
    .select('ended_at,messages').eq('user_id', currentUserId).maybeSingle();
  if (error || !data || !Array.isArray(data.messages) || data.messages.length === 0) {
    button.classList.add('hidden');
    return;
  }
  button.textContent = `View your last chat · ${new Date(data.ended_at).toLocaleDateString()}`;
  button.classList.remove('hidden');
}
async function showLastChatHistory() {
  if (!currentUserId) await ensureSignedIn();
  const { data, error } = await supabaseClient.from('after_dark_last_chat')
    .select('ended_at,messages').eq('user_id', currentUserId).maybeSingle();
  if (error || !data) { showToast('Your last chat history is not available yet.'); return; }
  const list = $('history-messages');
  list.innerHTML = '';
  data.messages.forEach((message) => {
    const item = document.createElement('div');
    item.className = `message history-message ${message.mine ? 'mine' : 'theirs'}`;
    if (!message.mine) {
      const author = document.createElement('span');
      author.className = 'message-author';
      author.textContent = 'Stranger';
      item.append(author);
    }
    const body = document.createElement('p');
    body.textContent = message.body;
    const time = document.createElement('time');
    time.textContent = new Date(message.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    item.append(body, time);
    list.append(item);
  });
  $('history-dialog').showModal();
}
async function detachRoom() {
  if (matchLoop) clearInterval(matchLoop);
  matchLoop = null;
  if (currentChannel) await supabaseClient.removeChannel(currentChannel);
  currentChannel = null;
  const roomId = currentRoomId;
  if (currentUserId) {
    await supabaseClient.rpc('leave_after_dark_chat', { target_room_id: roomId });
    if (roomId) {
      try { localStorage.removeItem(activeRoomKey(currentUserId)); } catch (_) {}
    }
  }
  currentRoomId = null;
}
async function resetChat() {
  searchToken += 1;
  await detachRoom();
  conversation.classList.add('hidden');
  waitingState.classList.add('hidden');
  emptyState.classList.remove('hidden');
  $('card-foot').classList.remove('hidden');
  chatCard.classList.remove('is-chatting');
  statusText.textContent = 'YOUR CALL';
  cardTitle.textContent = 'Ready when you are';
  messageList.innerHTML = '<div class="time-divider">YOU’RE BOTH HERE · SAY HELLO</div>';
  await loadLastChatPreview();
}
function showMessage(row) {
  if (messageList.querySelector(`[data-message-id="${row.id}"]`)) return;
  const item = document.createElement('div');
  item.dataset.messageId = row.id;
  item.className = `message ${row.sender_id === currentUserId ? 'mine' : 'theirs'}`;
  if (row.sender_id !== currentUserId || row.sender_name) {
    const author = document.createElement('span');
    author.className = 'message-author';
    author.textContent = row.sender_name || (row.sender_id === currentUserId ? 'You' : 'Stranger');
    item.append(author);
  }
  if (row.sender_id !== currentUserId) $('stranger-name').textContent = row.sender_name || 'A stranger';
  const body = document.createElement('p');
  body.textContent = row.body;
  const time = document.createElement('time');
  time.textContent = new Date(row.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  item.append(body, time);
  messageList.append(item);
  messageList.scrollTop = messageList.scrollHeight;
}
async function openRoom(roomId) {
  currentRoomId = roomId;
  if (currentUserId) {
    try { localStorage.setItem(activeRoomKey(currentUserId), roomId); } catch (_) {}
  }
  messageList.innerHTML = '<div class="time-divider">YOU’RE BOTH HERE · SAY HELLO</div>';
  $('stranger-name').textContent = 'A stranger';
  $('avatar').textContent = '✳';
  $('avatar').style.background = '#2b392d';
  setConnectionStatus(true);
  waitingState.classList.add('hidden');
  emptyState.classList.add('hidden');
  conversation.classList.remove('hidden');
  $('card-foot').classList.add('hidden');
  chatCard.classList.add('is-chatting');
  statusText.textContent = 'CONNECTED';
  cardTitle.textContent = 'A new conversation';
  currentChannel = supabaseClient.channel(roomId, { config: { private: true } })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room_id=eq.${roomId}` }, (payload) => {
      if (currentRoomId === roomId) showMessage(payload.new);
    })
    .subscribe(async (status, error) => {
      if (currentRoomId !== roomId) return;
      if (status === 'SUBSCRIBED') {
        // Catch up after the subscription is active so messages sent while joining aren't missed.
        const { data, error: historyError } = await supabaseClient.from('chat_messages')
          .select('id,sender_id,sender_name,body,created_at').eq('room_id', roomId).order('created_at');
        if (currentRoomId !== roomId) return;
        if (historyError) showToast('Could not sync recent messages.');
        else data.forEach(showMessage);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.error('After Dark Realtime subscription failed:', status, error);
        showToast('Live updates are unavailable. Check the Supabase Realtime setup.');
      }
    });
}
async function lookForMatch(preferences, token) {
  if (matchRequestInFlight || token !== searchToken) return;
  matchRequestInFlight = true;
  try {
  const { data: roomId, error } = await supabaseClient.rpc('find_after_dark_chat', {
    p_gender: preferences.gender,
    p_country: preferences.country,
    p_preferred_gender: preferences.preferredGender,
    p_preferred_country: preferences.preferredCountry
  });
  if (error) throw error;
  if (token !== searchToken) return;
  if (roomId) {
    clearInterval(matchLoop);
    matchLoop = null;
    await openRoom(roomId);
  }
  } finally {
    matchRequestInFlight = false;
  }
}
async function startSearch() {
  if (chatMode === 'group') {
    showToast('Interest groups are still a preview. Real matching is available for 1:1 chats.');
    return;
  }
  const quickAnonymous = $('quick-anonymous').checked;
  const preferences = quickAnonymous ? {
    gender: 'prefer_not_to_say', country: 'other', preferredGender: 'any', preferredCountry: 'anywhere'
  } : {
    gender: $('self-gender').value,
    country: $('self-country').value,
    preferredGender: $('gender-preference').value,
    preferredCountry: $('location-preference').value
  };
  if (!quickAnonymous && (!preferences.gender || !preferences.country)) {
    showToast('Choose your gender and country first.');
    return;
  }
  const token = ++searchToken;
  startButton.disabled = true;
  emptyState.classList.add('hidden');
  conversation.classList.add('hidden');
  waitingState.classList.remove('hidden');
  $('card-foot').classList.add('hidden');
  statusText.textContent = 'LOOKING';
  cardTitle.textContent = 'A moment of possibility';
  try {
    await ensureSignedIn();
    await recoverInterruptedChat();
    await loadLastChatPreview();
    if (token !== searchToken) return;
    await lookForMatch(preferences, token);
    if (!currentRoomId && token === searchToken) {
      matchLoop = setInterval(() => lookForMatch(preferences, token).catch((error) => {
        if (token === searchToken) { showToast(error.message || 'Matchmaking stopped. Please try again.'); resetChat(); }
      }), 1800);
      showToast('Looking for someone. Keep this page open.');
    }
  } catch (error) {
    if (token === searchToken) {
      await resetChat();
      showToast(error.message || 'Could not connect. Check your Supabase setup.');
    }
  } finally {
    startButton.disabled = false;
  }
}
startButton.addEventListener('click', startSearch);
cancelButton.addEventListener('click', resetChat);
async function skipChat() {
  await resetChat();
  showToast('Looking for someone new…');
  startSearch();
}
skipButton.addEventListener('click', skipChat);
leaveButton.addEventListener('click', () => { resetChat(); showToast('You left the chat.'); });
$('mode-one').addEventListener('click', () => setMode('one'));
$('mode-group').addEventListener('click', () => setMode('group'));
function setMode(mode) {
  chatMode = mode;
  $('mode-one').classList.toggle('active', mode === 'one');
  $('mode-group').classList.toggle('active', mode === 'group');
  $('mode-one').setAttribute('aria-selected', String(mode === 'one'));
  $('mode-group').setAttribute('aria-selected', String(mode === 'group'));
  $('quick-anonymous-row').classList.toggle('hidden', mode !== 'one');
  $('one-preferences').classList.toggle('hidden', mode !== 'one' || $('quick-anonymous').checked);
  $('group-preferences').classList.toggle('hidden', mode !== 'group');
  $('start-button').querySelector('span').textContent = mode === 'group' ? 'Preview interest groups' : ($('quick-anonymous').checked ? 'Start anonymous chat' : 'Find someone to talk to');
  $('skip-label').textContent = mode === 'group' ? 'Try another group' : 'Meet someone else';
  $('preference-note').textContent = mode === 'group' ? 'Interest groups are coming soon' : ($('quick-anonymous').checked ? 'No profile details needed · a random name keeps you anonymous' : 'Matching respects both users’ choices');
}
$('quick-anonymous').addEventListener('change', () => {
  const enabled = $('quick-anonymous').checked;
  $('one-preferences').classList.toggle('hidden', enabled || chatMode !== 'one');
  $('start-button').querySelector('span').textContent = enabled ? 'Start anonymous chat' : 'Find someone to talk to';
  $('preference-note').textContent = enabled ? 'No profile details needed · a random name keeps you anonymous' : 'Matching respects both users’ choices';
});
$('message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('message-input');
  const body = input.value.trim();
  if (!body || !currentRoomId) return;
  input.value = '';
  const senderName = $('quick-anonymous').checked ? currentUsername : null;
  const { data, error } = await supabaseClient.from('chat_messages').insert({ room_id: currentRoomId, sender_id: currentUserId, sender_name: senderName, body }).select('id,sender_id,sender_name,body,created_at').single();
  if (error) { showToast('Message could not be sent. Try again.'); input.value = body; return; }
  showMessage(data);
});
$('report-button').addEventListener('click', async () => {
  if (!currentRoomId || reportBusy) return;
  reportBusy = true;
  const roomId = currentRoomId;
  const { error } = await supabaseClient.rpc('report_after_dark_chat', { target_room_id: roomId });
  reportBusy = false;
  await resetChat();
  showToast(error ? 'Could not send report. Please try again later.' : 'Report sent. You left the chat.');
});
$('history-button').addEventListener('click', () => showLastChatHistory().catch((error) => showToast(error.message)));
$('close-history').addEventListener('click', () => $('history-dialog').close());
$('history-done').addEventListener('click', () => $('history-dialog').close());
supabaseClient?.auth.getSession().then(({ data }) => {
  if (data.session) {
    currentUserId = data.session.user.id;
    loadLastChatPreview();
  }
});
function openSafety() { dialog.showModal(); }
$('safety-link').addEventListener('click', openSafety);
$('footer-safety').addEventListener('click', openSafety);
$('close-dialog').addEventListener('click', () => dialog.close());
$('dialog-done').addEventListener('click', () => dialog.close());




