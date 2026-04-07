// sidepanel/sidepanel.js — Side Panel logic

const STATUS_ICONS = {
  pending: '',
  running: '',
  completed: '\u2713',  // ✓
  skipped: '\u00BB',    // »
  failed: '\u2717',     // ✗
  stopped: '\u25A0',    // ■
};

const logArea = document.getElementById('log-area');
const displayOauthUrl = document.getElementById('display-oauth-url');
const displayLocalhostUrl = document.getElementById('display-localhost-url');
const displayStatus = document.getElementById('display-status');
const statusBar = document.getElementById('status-bar');
const icloudSection = document.getElementById('icloud-section');
const icloudSummary = document.getElementById('icloud-summary');
const icloudList = document.getElementById('icloud-list');
const btnIcloudRefresh = document.getElementById('btn-icloud-refresh');
const btnIcloudDeleteUsed = document.getElementById('btn-icloud-delete-used');
const rowMailProvider = document.getElementById('row-mail-provider');
const inputEmail = document.getElementById('input-email');
const inputPassword = document.getElementById('input-password');
const btnFetchEmail = document.getElementById('btn-fetch-email');
const btnTogglePassword = document.getElementById('btn-toggle-password');
const btnStop = document.getElementById('btn-stop');
const btnReset = document.getElementById('btn-reset');
const stepsProgress = document.getElementById('steps-progress');
const btnAutoRun = document.getElementById('btn-auto-run');
const btnAutoContinue = document.getElementById('btn-auto-continue');
const autoContinueBar = document.getElementById('auto-continue-bar');
const btnClearLog = document.getElementById('btn-clear-log');
const inputVpsUrl = document.getElementById('input-vps-url');
const selectMailProvider = document.getElementById('select-mail-provider');
const rowInbucketHost = document.getElementById('row-inbucket-host');
const inputInbucketHost = document.getElementById('input-inbucket-host');
const rowInbucketMailbox = document.getElementById('row-inbucket-mailbox');
const inputInbucketMailbox = document.getElementById('input-inbucket-mailbox');
const inputRunCount = document.getElementById('input-run-count');
const autoHint = document.getElementById('auto-hint');

// ============================================================
// Toast Notifications
// ============================================================

const toastContainer = document.getElementById('toast-container');

const TOAST_ICONS = {
  error: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  success: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  info: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
};

function showToast(message, type = 'error', duration = 4000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] || ''}<span class="toast-msg">${escapeHtml(message)}</span><button class="toast-close">&times;</button>`;

  toast.querySelector('.toast-close').addEventListener('click', () => dismissToast(toast));
  toastContainer.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => dismissToast(toast), duration);
  }
}

function dismissToast(toast) {
  if (!toast.parentNode) return;
  toast.classList.add('toast-exit');
  toast.addEventListener('animationend', () => toast.remove());
}

// ============================================================
// State Restore on load
// ============================================================

async function restoreState() {
  try {
    const state = await chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' });

    if (state.oauthUrl) {
      displayOauthUrl.textContent = state.oauthUrl;
      displayOauthUrl.classList.add('has-value');
    }
    if (state.localhostUrl) {
      displayLocalhostUrl.textContent = state.localhostUrl;
      displayLocalhostUrl.classList.add('has-value');
    }
    if (state.email) {
      inputEmail.value = state.email;
    }
    syncPasswordField(state);
    if (state.vpsUrl) {
      inputVpsUrl.value = state.vpsUrl;
    }
    if (state.mailProvider) {
      selectMailProvider.value = state.mailProvider;
    }
    if (state.inbucketHost) {
      inputInbucketHost.value = state.inbucketHost;
    }
    if (state.inbucketMailbox) {
      inputInbucketMailbox.value = state.inbucketMailbox;
    }

    if (state.stepStatuses) {
      for (const [step, status] of Object.entries(state.stepStatuses)) {
        updateStepUI(Number(step), status);
      }
    }

    if (state.logs) {
      for (const entry of state.logs) {
        appendLog(entry);
      }
    }

    updateStatusDisplay(state);
    updateProgressCounter();
    updateEmailSourceUI();
    updateMailProviderUI();

    if (state.autoRunPausedPhase === 'waiting_email') {
      autoContinueBar.dataset.reason = 'waiting_email';
      autoHint.textContent = 'Generate or paste an iCloud alias, then continue';
      autoContinueBar.style.display = 'flex';
      btnAutoRun.disabled = false;
      inputRunCount.disabled = false;
    } else if (state.autoRunPausedPhase === 'error') {
      autoContinueBar.dataset.reason = 'error';
      autoHint.textContent = 'Auto run was interrupted by an error. Fix it or skip the failed step, then continue';
      autoContinueBar.style.display = 'flex';
      btnAutoRun.disabled = false;
      inputRunCount.disabled = false;
    }
  } catch (err) {
    console.error('Failed to restore state:', err);
  }
}

function syncPasswordField(state) {
  inputPassword.value = state.customPassword || state.password || '';
}

function updateMailProviderUI() {
  const useInbucket = selectMailProvider.value === 'inbucket';
  rowMailProvider.style.display = '';
  rowInbucketHost.style.display = useInbucket ? '' : 'none';
  rowInbucketMailbox.style.display = useInbucket ? '' : 'none';
}

function updateEmailSourceUI() {
  inputEmail.placeholder = 'Use Auto to generate an iCloud Hide My Email alias';
  autoHint.textContent = 'Use Auto to generate an iCloud alias, or paste manually, then continue';
  btnFetchEmail.disabled = false;
  btnFetchEmail.title = 'Generate a new iCloud Hide My Email alias';
  icloudSection.style.display = '';
}

// ============================================================
// UI Updates
// ============================================================

function updateStepUI(step, status) {
  const statusEl = document.querySelector(`.step-status[data-step="${step}"]`);
  const row = document.querySelector(`.step-row[data-step="${step}"]`);

  if (statusEl) statusEl.textContent = STATUS_ICONS[status] || '';
  if (row) {
    row.className = `step-row ${status}`;
  }

  updateButtonStates();
  updateProgressCounter();
}

function updateProgressCounter() {
  let completed = 0;
  document.querySelectorAll('.step-row').forEach(row => {
    if (row.classList.contains('completed') || row.classList.contains('skipped')) completed++;
  });
  stepsProgress.textContent = `${completed} / 9`;
}

function updateButtonStates() {
  const statuses = {};
  document.querySelectorAll('.step-row').forEach(row => {
    const step = Number(row.dataset.step);
    if (row.classList.contains('completed')) statuses[step] = 'completed';
    else if (row.classList.contains('skipped')) statuses[step] = 'skipped';
    else if (row.classList.contains('running')) statuses[step] = 'running';
    else if (row.classList.contains('failed')) statuses[step] = 'failed';
    else if (row.classList.contains('stopped')) statuses[step] = 'stopped';
    else statuses[step] = 'pending';
  });

  const anyRunning = Object.values(statuses).some(s => s === 'running');

  for (let step = 1; step <= 9; step++) {
    const btn = document.querySelector(`.step-btn[data-step="${step}"]`);
    const skipBtn = document.querySelector(`.step-skip-btn[data-step="${step}"]`);
    if (!btn) continue;

    const currentStatus = statuses[step];

    if (anyRunning) {
      btn.disabled = true;
      if (skipBtn) skipBtn.disabled = true;
    } else if (step === 1) {
      btn.disabled = false;
    } else {
      const prevStatus = statuses[step - 1];
      btn.disabled = !(
        prevStatus === 'completed'
        || prevStatus === 'skipped'
        || currentStatus === 'failed'
        || currentStatus === 'completed'
        || currentStatus === 'stopped'
        || currentStatus === 'skipped'
      );
    }

    if (skipBtn) {
      skipBtn.disabled = !(currentStatus === 'failed' || currentStatus === 'stopped');
    }
  }

  updateStopButtonState(anyRunning || autoContinueBar.style.display !== 'none');
}

function updateStopButtonState(active) {
  btnStop.disabled = !active;
}

function updateStatusDisplay(state) {
  if (!state || !state.stepStatuses) return;

  statusBar.className = 'status-bar';

  const running = Object.entries(state.stepStatuses).find(([, s]) => s === 'running');
  if (running) {
    displayStatus.textContent = `Step ${running[0]} running...`;
    statusBar.classList.add('running');
    return;
  }

  const failed = Object.entries(state.stepStatuses).find(([, s]) => s === 'failed');
  if (failed) {
    displayStatus.textContent = `Step ${failed[0]} failed`;
    statusBar.classList.add('failed');
    return;
  }

  const stopped = Object.entries(state.stepStatuses).find(([, s]) => s === 'stopped');
  if (stopped) {
    displayStatus.textContent = `Step ${stopped[0]} stopped`;
    statusBar.classList.add('stopped');
    return;
  }

  const entries = Object.entries(state.stepStatuses);
  const allProgressed = entries.every(([, s]) => s === 'completed' || s === 'skipped');
  if (allProgressed) {
    displayStatus.textContent = 'All steps finished';
    statusBar.classList.add('completed');
    return;
  }

  const lastProgressed = entries
    .filter(([, s]) => s === 'completed' || s === 'skipped')
    .map(([k]) => Number(k))
    .sort((a, b) => b - a)[0];

  if (lastProgressed) {
    displayStatus.textContent = state.stepStatuses[lastProgressed] === 'skipped'
      ? `Step ${lastProgressed} skipped`
      : `Step ${lastProgressed} done`;
  } else {
    displayStatus.textContent = 'Ready';
  }
}

function appendLog(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false });
  const levelLabel = entry.level.toUpperCase();
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const stepMatch = entry.message.match(/Step (\d)/);
  const stepNum = stepMatch ? stepMatch[1] : null;

  let html = `<span class="log-time">${time}</span> `;
  html += `<span class="log-level log-level-${entry.level}">${levelLabel}</span> `;
  if (stepNum) {
    html += `<span class="log-step-tag step-${stepNum}">S${stepNum}</span>`;
  }
  html += `<span class="log-msg">${escapeHtml(entry.message)}</span>`;

  line.innerHTML = html;
  logArea.appendChild(line);
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function fetchConfiguredEmail() {
  const defaultLabel = 'Auto';
  btnFetchEmail.disabled = true;
  btnFetchEmail.textContent = '...';
  const sourceLabel = 'iCloud Hide My Email';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'FETCH_AUTO_EMAIL',
      source: 'sidepanel',
      payload: { generateNew: true },
    });

    if (response?.error) {
      throw new Error(response.error);
    }
    if (!response?.email) {
      throw new Error(`${sourceLabel} email was not returned.`);
    }

    inputEmail.value = response.email;
    showToast(`Fetched ${response.email}`, 'success', 2500);
    return response.email;
  } catch (err) {
    showToast(`Auto fetch failed: ${err.message}`, 'error');
    throw err;
  } finally {
    btnFetchEmail.disabled = false;
    btnFetchEmail.textContent = defaultLabel;
  }
}

function setIcloudLoadingState(loading, summary = '') {
  btnIcloudRefresh.disabled = loading;
  btnIcloudDeleteUsed.disabled = loading;
  if (summary) icloudSummary.textContent = summary;
}

function renderIcloudAliases(aliases = []) {
  icloudList.innerHTML = '';

  if (!aliases.length) {
    icloudList.innerHTML = '<div class="icloud-empty">No iCloud Hide My Email aliases found.</div>';
    icloudSummary.textContent = '0 aliases loaded.';
    btnIcloudDeleteUsed.disabled = true;
    return;
  }

  const usedCount = aliases.filter(alias => alias.used).length;
  icloudSummary.textContent = `${aliases.length} aliases loaded. ${usedCount} marked as used in this plugin.`;
  btnIcloudDeleteUsed.disabled = usedCount === 0;

  for (const alias of aliases) {
    const item = document.createElement('div');
    item.className = 'icloud-item';
    item.innerHTML = `
      <div class="icloud-item-main">
        <div class="icloud-item-email">${escapeHtml(alias.email)}</div>
        <div class="icloud-item-meta">
          ${alias.used ? '<span class="icloud-tag used">Used</span>' : ''}
          ${alias.active ? '<span class="icloud-tag active">Active</span>' : ''}
          ${alias.label ? `<span class="icloud-tag">${escapeHtml(alias.label)}</span>` : ''}
          ${alias.note ? `<span class="icloud-tag">${escapeHtml(alias.note)}</span>` : ''}
        </div>
      </div>
      <button class="btn btn-outline btn-xs" type="button">Delete</button>
    `;

    item.querySelector('button').addEventListener('click', async () => {
      await deleteSingleIcloudAlias(alias);
    });
    icloudList.appendChild(item);
  }
}

async function refreshIcloudAliases(options = {}) {
  const { silent = false } = options;

  if (!silent) setIcloudLoadingState(true, 'Loading iCloud aliases...');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'LIST_ICLOUD_ALIASES',
      source: 'sidepanel',
      payload: {},
    });

    if (response?.error) throw new Error(response.error);
    renderIcloudAliases(response?.aliases || []);
  } catch (err) {
    icloudList.innerHTML = '<div class="icloud-empty">Could not load iCloud aliases.</div>';
    icloudSummary.textContent = err.message;
    if (!silent) showToast(`iCloud load failed: ${err.message}`, 'error');
  } finally {
    btnIcloudRefresh.disabled = false;
  }
}

async function deleteSingleIcloudAlias(alias) {
  setIcloudLoadingState(true, `Deleting ${alias.email}...`);
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DELETE_ICLOUD_ALIAS',
      source: 'sidepanel',
      payload: { email: alias.email, anonymousId: alias.anonymousId },
    });
    if (response?.error) throw new Error(response.error);
    showToast(`Deleted ${alias.email}`, 'success', 2500);
    await refreshIcloudAliases({ silent: true });
  } catch (err) {
    showToast(`Delete failed: ${err.message}`, 'error');
    icloudSummary.textContent = err.message;
  } finally {
    btnIcloudRefresh.disabled = false;
  }
}

async function deleteUsedIcloudAliases() {
  setIcloudLoadingState(true, 'Deleting used iCloud aliases...');
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'DELETE_USED_ICLOUD_ALIASES',
      source: 'sidepanel',
      payload: {},
    });
    if (response?.error) throw new Error(response.error);

    const deleted = response?.deleted || [];
    const skipped = response?.skipped || [];
    const summary = `Deleted ${deleted.length} used aliases${skipped.length ? `, ${skipped.length} skipped` : ''}.`;
    showToast(summary, skipped.length ? 'warn' : 'success', 3000);
    await refreshIcloudAliases({ silent: true });
  } catch (err) {
    showToast(`Bulk delete failed: ${err.message}`, 'error');
    icloudSummary.textContent = err.message;
  } finally {
    btnIcloudRefresh.disabled = false;
  }
}

function syncPasswordToggleLabel() {
  btnTogglePassword.textContent = inputPassword.type === 'password' ? 'Show' : 'Hide';
}

// ============================================================
// Button Handlers
// ============================================================

document.querySelectorAll('.step-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    if (step === 3) {
      const email = inputEmail.value.trim();
      if (!email) {
        showToast('Please paste email address or use Auto first', 'warn');
        return;
      }
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step, email } });
    } else {
      await chrome.runtime.sendMessage({ type: 'EXECUTE_STEP', source: 'sidepanel', payload: { step } });
    }
  });
});

document.querySelectorAll('.step-skip-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const step = Number(btn.dataset.step);
    const response = await chrome.runtime.sendMessage({
      type: 'SKIP_STEP',
      source: 'sidepanel',
      payload: { step },
    });
    if (response?.error) {
      showToast(`Skip failed: ${response.error}`, 'error');
      return;
    }
    showToast(`Step ${step} skipped`, 'warn', 2000);
  });
});

btnFetchEmail.addEventListener('click', async () => {
  await fetchConfiguredEmail().catch(() => {});
  await refreshIcloudAliases({ silent: true });
});

btnIcloudRefresh.addEventListener('click', async () => {
  await refreshIcloudAliases();
});

btnIcloudDeleteUsed.addEventListener('click', async () => {
  await deleteUsedIcloudAliases();
});

btnTogglePassword.addEventListener('click', () => {
  inputPassword.type = inputPassword.type === 'password' ? 'text' : 'password';
  syncPasswordToggleLabel();
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  await chrome.runtime.sendMessage({ type: 'STOP_FLOW', source: 'sidepanel', payload: {} });
  showToast('Stopping current flow...', 'warn', 2000);
});

// Auto Run
btnAutoRun.addEventListener('click', async () => {
  const totalRuns = parseInt(inputRunCount.value) || 1;
  btnAutoRun.disabled = true;
  inputRunCount.disabled = true;
  btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg> Running...';
  await chrome.runtime.sendMessage({ type: 'AUTO_RUN', source: 'sidepanel', payload: { totalRuns } });
});

btnAutoContinue.addEventListener('click', async () => {
  const reason = autoContinueBar.dataset.reason || 'waiting_email';
  const email = inputEmail.value.trim();
  if (reason === 'waiting_email' && !email) {
    showToast('Please fetch or paste an email address first!', 'warn');
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: 'CONTINUE_AUTO_RUN',
    source: 'sidepanel',
    payload: { email },
  });
  if (response?.error) {
    showToast(`Continue failed: ${response.error}`, 'error');
    return;
  }
  autoContinueBar.style.display = 'none';
  autoContinueBar.dataset.reason = '';
});

// Reset
btnReset.addEventListener('click', async () => {
  if (confirm('Reset all steps and data?')) {
    await chrome.runtime.sendMessage({ type: 'RESET', source: 'sidepanel' });
    displayOauthUrl.textContent = 'Waiting...';
    displayOauthUrl.classList.remove('has-value');
    displayLocalhostUrl.textContent = 'Waiting...';
    displayLocalhostUrl.classList.remove('has-value');
    inputEmail.value = '';
    displayStatus.textContent = 'Ready';
    statusBar.className = 'status-bar';
    logArea.innerHTML = '';
    document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
    document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
    btnAutoRun.disabled = false;
    inputRunCount.disabled = false;
    btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
    autoContinueBar.style.display = 'none';
    updateStopButtonState(false);
    updateButtonStates();
    updateProgressCounter();
  }
});

// Clear log
btnClearLog.addEventListener('click', () => {
  logArea.innerHTML = '';
});

// Save settings on change
inputEmail.addEventListener('change', async () => {
  const email = inputEmail.value.trim();
  if (email) {
    await chrome.runtime.sendMessage({ type: 'SAVE_EMAIL', source: 'sidepanel', payload: { email } });
  }
});

inputVpsUrl.addEventListener('change', async () => {
  const vpsUrl = inputVpsUrl.value.trim();
  if (vpsUrl) {
    await chrome.runtime.sendMessage({ type: 'SAVE_SETTING', source: 'sidepanel', payload: { vpsUrl } });
  }
});

inputPassword.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { customPassword: inputPassword.value },
  });
});

selectMailProvider.addEventListener('change', async () => {
  updateMailProviderUI();
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING', source: 'sidepanel',
    payload: { mailProvider: selectMailProvider.value },
  });
});

inputInbucketMailbox.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { inbucketMailbox: inputInbucketMailbox.value.trim() },
  });
});

inputInbucketHost.addEventListener('change', async () => {
  await chrome.runtime.sendMessage({
    type: 'SAVE_SETTING',
    source: 'sidepanel',
    payload: { inbucketHost: inputInbucketHost.value.trim() },
  });
});

// ============================================================
// Listen for Background broadcasts
// ============================================================

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'LOG_ENTRY':
      appendLog(message.payload);
      if (message.payload.level === 'error') {
        showToast(message.payload.message, 'error');
      }
      break;

    case 'STEP_STATUS_CHANGED': {
      const { step, status } = message.payload;
      updateStepUI(step, status);
      chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(updateStatusDisplay);
      if (status === 'completed') {
        chrome.runtime.sendMessage({ type: 'GET_STATE', source: 'sidepanel' }).then(state => {
          syncPasswordField(state);
          if (state.oauthUrl) {
            displayOauthUrl.textContent = state.oauthUrl;
            displayOauthUrl.classList.add('has-value');
          }
          if (state.localhostUrl) {
            displayLocalhostUrl.textContent = state.localhostUrl;
            displayLocalhostUrl.classList.add('has-value');
          }
        });
      }
      break;
    }

    case 'AUTO_RUN_RESET': {
      // Full UI reset for next run
      displayOauthUrl.textContent = 'Waiting...';
      displayOauthUrl.classList.remove('has-value');
      displayLocalhostUrl.textContent = 'Waiting...';
      displayLocalhostUrl.classList.remove('has-value');
      inputEmail.value = '';
      displayStatus.textContent = 'Ready';
      statusBar.className = 'status-bar';
      logArea.innerHTML = '';
      document.querySelectorAll('.step-row').forEach(row => row.className = 'step-row');
      document.querySelectorAll('.step-status').forEach(el => el.textContent = '');
      icloudList.innerHTML = '';
      icloudSummary.textContent = 'Load your Hide My Email aliases to manage them here.';
      updateStopButtonState(false);
      updateProgressCounter();
      break;
    }

    case 'DATA_UPDATED': {
      if (message.payload.email) {
        inputEmail.value = message.payload.email;
      }
      if (message.payload.password !== undefined) {
        inputPassword.value = message.payload.password || '';
      }
      if (message.payload.oauthUrl) {
        displayOauthUrl.textContent = message.payload.oauthUrl;
        displayOauthUrl.classList.add('has-value');
      }
      if (message.payload.localhostUrl) {
        displayLocalhostUrl.textContent = message.payload.localhostUrl;
        displayLocalhostUrl.classList.add('has-value');
      }
      break;
    }

    case 'ICLOUD_LOGIN_REQUIRED': {
      const loginMessage = message.payload?.message || 'iCloud login required.';
      showToast(loginMessage, 'warn', 5000);
      icloudSummary.textContent = loginMessage;
      break;
    }

    case 'AUTO_RUN_STATUS': {
      const { phase, currentRun, totalRuns } = message.payload;
      const runLabel = totalRuns > 1 ? ` (${currentRun}/${totalRuns})` : '';
      switch (phase) {
        case 'waiting_email':
          autoContinueBar.dataset.reason = 'waiting_email';
          autoHint.textContent = 'Generate or paste an iCloud alias, then continue';
          autoContinueBar.style.display = 'flex';
          btnAutoRun.innerHTML = `Paused${runLabel}`;
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          updateStopButtonState(true);
          break;
        case 'error':
          autoContinueBar.dataset.reason = 'error';
          autoHint.textContent = 'Auto run was interrupted by an error. Fix it or skip the failed step, then continue';
          autoContinueBar.style.display = 'flex';
          btnAutoRun.innerHTML = `Interrupted${runLabel}`;
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          updateStopButtonState(false);
          break;
        case 'running':
          autoContinueBar.dataset.reason = '';
          autoContinueBar.style.display = 'none';
          btnAutoRun.innerHTML = `Running${runLabel}`;
          btnAutoRun.disabled = true;
          inputRunCount.disabled = true;
          updateStopButtonState(true);
          break;
        case 'complete':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          autoContinueBar.dataset.reason = '';
          updateStopButtonState(false);
          break;
        case 'stopped':
          btnAutoRun.disabled = false;
          inputRunCount.disabled = false;
          btnAutoRun.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg> Auto';
          autoContinueBar.style.display = 'none';
          autoContinueBar.dataset.reason = '';
          updateStopButtonState(false);
          break;
      }
      break;
    }
  }
});

// ============================================================
// Theme Toggle
// ============================================================

const btnTheme = document.getElementById('btn-theme');

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('multipage-theme', theme);
}

function initTheme() {
  const saved = localStorage.getItem('multipage-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
}

btnTheme.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

// ============================================================
// Init
// ============================================================

initTheme();
restoreState().then(() => {
  syncPasswordToggleLabel();
  updateButtonStates();
  refreshIcloudAliases({ silent: true });
});
