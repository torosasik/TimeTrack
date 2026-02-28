/**
 * Toast Notification System
 */

let toastContainer = null;

// Initialize toast container
function initToastContainer() {
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }
}

/**
 * Show a toast notification
 * @param {string} message - Message to display
 * @param {string} type - Type of toast (success, error, warning, info)
 * @param {number} duration - Duration in ms (default: 5000)
 */
export function showToast(message, type = 'info', duration = 5000) {
    initToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };

    const titles = {
        success: 'Success',
        error: 'Error',
        warning: 'Warning',
        info: 'Info'
    };

    toast.innerHTML = `
    <div class="toast-icon">${icons[type]}</div>
    <div class="toast-content">
      <div class="toast-title">${titles[type]}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" aria-label="Close">×</button>
  `;

    toastContainer.appendChild(toast);

    // Close button
    const closeBtn = toast.querySelector('.toast-close');
    closeBtn.addEventListener('click', () => removeToast(toast));

    // Auto remove
    setTimeout(() => removeToast(toast), duration);
}

function removeToast(toast) {
    toast.classList.add('toast-exit');
    setTimeout(() => {
        if (toast.parentNode) {
            toast.parentNode.removeChild(toast);
        }
    }, 300);
}

/**
 * Network Status Monitor
 */

let networkStatusEl = null;
let isOnline = navigator.onLine;

export function initNetworkMonitor() {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (!isOnline) {
        showNetworkStatus(false);
    }
}

function handleOnline() {
    isOnline = true;
    showNetworkStatus(true);
    showToast('Connection restored', 'success', 3000);

    setTimeout(() => {
        if (networkStatusEl) {
            networkStatusEl.remove();
            networkStatusEl = null;
        }
    }, 3000);
}

function handleOffline() {
    isOnline = false;
    showNetworkStatus(false);
    showToast('No internet connection', 'error', 5000);
}

function showNetworkStatus(online) {
    if (!networkStatusEl) {
        networkStatusEl = document.createElement('div');
        document.body.appendChild(networkStatusEl);
    }

    networkStatusEl.className = `network-status ${online ? 'online' : ''}`;
    networkStatusEl.textContent = online ? '🌐 Back Online' : '📡 Offline';
}

/**
 * Form Validation with Inline Errors
 */

export function validateField(input, validationFn, errorMessage) {
    const value = input.value.trim();
    const isValid = validationFn(value);

    // Remove existing error
    const existingError = input.parentElement.querySelector('.form-error');
    if (existingError) {
        existingError.remove();
    }

    input.classList.remove('error', 'success');

    if (!isValid && value !== '') {
        input.classList.add('error');

        const error = document.createElement('span');
        error.className = 'form-error';
        error.textContent = errorMessage;
        input.parentElement.appendChild(error);

        return false;
    } else if (value !== '') {
        input.classList.add('success');
    }

    return true;
}

/**
 * Loading Skeleton
 */

export function showLoadingSkeleton(container, type = 'card') {
    const skeletons = {
        card: `
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    `,
        list: `
      <div class="skeleton skeleton-title"></div>
      <div class="skeleton skeleton-text"></div>
      <div class="skeleton skeleton-text"></div>
      <div class="skeleton skeleton-text"></div>
    `,
        table: `
      <div class="skeleton skeleton-title" style="width: 100%; height: 40px; margin-bottom: 1rem;"></div>
      <div class="skeleton skeleton-text" style="width: 100%; height: 50px; margin-bottom: 0.5rem;"></div>
      <div class="skeleton skeleton-text" style="width: 100%; height: 50px; margin-bottom: 0.5rem;"></div>
      <div class="skeleton skeleton-text" style="width: 100%; height: 50px; margin-bottom: 0.5rem;"></div>
    `
    };

    container.innerHTML = skeletons[type] || skeletons.card;
}

/**
 * Show Empty State
 */

export function showEmptyState(container, icon, title, message, actionButton = null) {
    container.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">${icon}</div>
      <div class="empty-state-title">${title}</div>
      <div class="empty-state-message">${message}</div>
      ${actionButton ? `<button class="btn btn-primary">${actionButton}</button>` : ''}
    </div>
  `;
}

/**
 * Auto-focus first field
 */

export function autoFocusFirstField(form) {
    const firstInput = form.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])');
    if (firstInput) {
        setTimeout(() => firstInput.focus(), 100);
    }
}

/**
 * Format date to prevent future dates
 */

export function getMaxDate() {
    const today = new Date();
    return today.toISOString().split('T')[0];
}

/**
 * Success Animation
 */

export function showSuccessAnimation(container) {
    container.innerHTML = `
    <div class="success-checkmark">
      <div class="check-icon">
        <span class="icon-line line-tip"></span>
        <span class="icon-line line-long"></span>
        <div class="icon-circle"></div>
        <div class="icon-fix"></div>
      </div>
    </div>
  `;
}
