// Enhanced JavaScript for LifePrep Academy Foundation Website
// Prevent browser from restoring a scrolled position on reload
if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
}

// DOM Content Loaded Event
document.addEventListener('DOMContentLoaded', function() {
    const hasEventsSection = !!document.querySelector('#events');

    if (hasEventsSection) {
        // Initialize photos first for immediate loading
        initEventPhotos();
        // Load default gallery immediately WITHOUT scrolling
        loadEventGallery('mmhe', { scroll: false });
        // Prefetch other images in background
        setTimeout(prefetchEventImages, 1000);
        initEventTabs();
    }

    // Initialize other functionality
    initSmoothScrolling(); // only affects same-page hash links
    initMobileMenu();
    initFormValidation();
    initImageModal();
    initScrollAnimations();
    initLazyLoading();
    initAnalytics();
    highlightCurrentPage();
    initAutoCopyrightYear();
    initImageFallbacks();
    initContactFormNetworkHandler();
    initOfflineReload();

    // Force initial position to top ONLY if user didn't load with a hash anchor
    requestAnimationFrame(() => {
        if (!location.hash && window.scrollY > 0) {
            window.scrollTo(0, 0);
        }
    });
    // Extra safeguard after assets settle
    window.addEventListener('load', () => {
        if (!location.hash && window.scrollY > 10) {
            window.scrollTo(0, 0);
        }
    });
});

function initAutoCopyrightYear() {
    const targets = document.querySelectorAll('[data-auto-year]');
    if (!targets.length) return;

    const year = String(new Date().getFullYear());
    targets.forEach(el => {
        el.textContent = year;
    });
}

function initImageFallbacks() {
    const imgs = document.querySelectorAll('img[data-fallback-src]');
    if (!imgs.length) return;

    imgs.forEach(img => {
        const fallback = img.getAttribute('data-fallback-src');
        if (!fallback) return;

        img.addEventListener('error', function onErr() {
            if (img.dataset.fallbackApplied === 'true') return;
            img.dataset.fallbackApplied = 'true';
            img.src = fallback;
        }, { once: true });
    });
}

function initOfflineReload() {
    const btn = document.getElementById('offlineReloadButton');
    if (!btn) return;
    btn.addEventListener('click', () => location.reload());
}

function shouldEnableTurnstile() {
    const host = (window.location.hostname || '').toLowerCase();
    const isLocalOrPreview = host === 'localhost' || host === '127.0.0.1' || host.endsWith('.pages.dev') || host.includes('preview');
    const captchaContainer = document.getElementById('captchaContainer');
    const siteKey = (captchaContainer?.getAttribute('data-sitekey') || '').trim();
    return !isLocalOrPreview && Boolean(siteKey && !siteKey.startsWith('0x000000'));
}

function initTurnstileWidget() {
    const captchaContainer = document.getElementById('captchaContainer');
    if (!captchaContainer) return false;

    const enabled = shouldEnableTurnstile();
    captchaContainer.setAttribute('data-turnstile-enabled', enabled ? 'true' : 'false');
    captchaContainer.style.display = enabled ? 'block' : 'none';

    if (!enabled) return false;

    if (!document.querySelector('script[data-turnstile-script="true"]')) {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
        script.async = true;
        script.defer = true;
        script.setAttribute('data-turnstile-script', 'true');
        document.body.appendChild(script);
    }

    return true;
}

// Contact form network handler (moved from inline script for CSP readiness)
function initContactFormNetworkHandler() {
    const form = document.getElementById('contactForm');
    if (!form) return;
    if (form.dataset.netHandlerInit === 'true') return;
    form.dataset.netHandlerInit = 'true';

    const statusDiv = document.getElementById('contact-form-status');
    const submitBtn = document.getElementById('contactSubmitBtn');
    // Website submissions are stored in Cloudflare D1 so the admin inbox is not
    // dependent on Google Apps Script. MLS registration mirroring remains handled
    // by the registration Worker separately.
    const FETCH_URL = form.id === 'contactForm'
        ? 'https://mlsregistration.lifeprepacademyfoundation.com/api/site-submissions'
        : form.getAttribute('action');
    const captchaContainer = document.getElementById('captchaContainer');
    const turnstileEnabled = initTurnstileWidget();

    // Config: client-side protections (UX only; server enforces real security)
    const MIN_DWELL_MS = 3000;                 // Require at least 3s on page before submit
    const MIN_INTERVAL_MS = 30 * 1000;         // 30s between submissions (per browser)
    const PER_EMAIL_INTERVAL_MS = 2 * 60 * 1000; // 2m cooldown per email (client-side)
    const MAX_TYPED_THRESHOLD = 12;            // Require user to actually type >= 12 chars across fields
    const REQUIRE_CAPTCHA = true;              // Enabled: require Turnstile on client to match server
    const EMAIL_BLOCKLIST = [                  // Optional quick blocklist
        // 'bad@example.com', '@spamdomain.com'
    ];

    let busy = false;
    const pageStart = Date.now();
    let statusHideTimer = null;

    const formType = (() => {
        try {
            const v = form.querySelector('input[name="form_type"]')?.value || '';
            const norm = String(v).trim().toLowerCase();
            return norm || 'contact';
        } catch {
            return 'contact';
        }
    })();

    // Persistent client id for coarse rate-limiting in backend logs
    const clientId = (() => {
        try {
            const k = 'contactClientId';
            const existing = localStorage.getItem(k);
            if (existing) return existing;
            const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(k, id);
            return id;
        } catch {
            return 'na';
        }
    })();

    // Track typed characters to filter raw bot posts
    let typedChars = 0;
    const fieldsToWatch = ['name', 'email', 'message'];
    const lastVal = {};
    fieldsToWatch.forEach(id => {
        const el = form.querySelector('#' + id);
        if (!el) return;
        lastVal[id] = '';
        el.addEventListener('input', () => {
            const prev = lastVal[id] || '';
            const cur = el.value || '';
            const delta = Math.max(0, cur.length - prev.length);
            typedChars += delta;
            lastVal[id] = cur;
        });
    });

    function track(action, category, label) {
        if (typeof trackEvent === 'function') trackEvent(action, category, label);
    }

    function setStatus(msg, isError = false) {
        if (!statusDiv) return;
        if (statusHideTimer) {
            clearTimeout(statusHideTimer);
            statusHideTimer = null;
        }
        statusDiv.textContent = msg;
        statusDiv.classList.remove('visually-hidden');
        statusDiv.classList.toggle('error', isError);

        // Toast behavior: auto-hide on success so it feels lightweight.
        const lowered = String(msg || '').trim().toLowerCase();
        const isSendingState = lowered === 'sending...' || lowered === 'sending';
        if (!isError && !isSendingState && lowered) {
            statusHideTimer = setTimeout(() => {
                try {
                    statusDiv.classList.add('visually-hidden');
                    statusDiv.textContent = '';
                    statusDiv.classList.remove('error');
                } catch {
                    // ignore
                }
            }, 6000);
        }
    }

    function toggle(disabled) {
        if (!submitBtn) return;
        submitBtn.disabled = disabled;
        submitBtn.style.opacity = disabled ? '0.6' : '1';
    }

    function emailBlocked(email) {
        if (!email) return false;
        const e = email.toLowerCase().trim();
        return EMAIL_BLOCKLIST.some(rule => {
            const r = rule.toLowerCase();
            return r.startsWith('@') ? e.endsWith(r) : e === r;
        });
    }

    function simpleValidate() {
        const requiredIds = ['name', 'email', 'subject', 'message'];
        for (const id of requiredIds) {
            const el = form.querySelector('#' + id);
            if (!el || !el.value.trim()) return `Missing required field: ${id}`;
        }
        // Dwell-time gate
        const dwell = Date.now() - pageStart;
        if (dwell < MIN_DWELL_MS) return 'Please take a few seconds to complete the form before submitting.';
        // Require some human typing
        if (typedChars < MAX_TYPED_THRESHOLD) return 'Please provide a bit more detail in your message.';
        // Blocklisted email/domains
        const email = form.querySelector('#email')?.value || '';
        if (emailBlocked(email)) return 'This email address is not permitted to submit the form.';
        return null;
    }

    function buildBody() {
        const fd = new FormData(form);
        if (fd.get('hp_field')) throw new Error('Spam detected');
        fd.append('userAgent', navigator.userAgent || '');
        fd.append('page', location.href);
        fd.append('submittedAt', new Date().toISOString());
        fd.append('clientId', clientId);
        fd.append('dwellMs', String(Date.now() - pageStart));
        fd.append('typedChars', String(typedChars));
        // If Turnstile is present, pass its token through to backend for verification
        try {
            const tsToken = document.querySelector('input[name="cf-turnstile-response"]')?.value;
            if (tsToken) fd.append('cf_turnstile_response', tsToken);
        } catch {
            // ignore
        }
        const params = new URLSearchParams();
        for (const [k, v] of fd.entries()) params.append(k, v);
        return params.toString();
    }

    function tooSoonGlobal() {
        try {
            const last = Number(localStorage.getItem('contactLastSubmitAt:' + formType) || '0');
            return Date.now() - last < MIN_INTERVAL_MS;
        } catch {
            return false;
        }
    }

    function tooSoonByEmail(email) {
        if (!email) return false;
        try {
            const key = 'contactLastSubmitByEmail:' + formType + ':' + email.toLowerCase();
            const last = Number(localStorage.getItem(key) || '0');
            return Date.now() - last < PER_EMAIL_INTERVAL_MS;
        } catch {
            return false;
        }
    }

    function recordSubmission(email) {
        try {
            localStorage.setItem('contactLastSubmitAt:' + formType, String(Date.now()));
            if (email) localStorage.setItem('contactLastSubmitByEmail:' + formType + ':' + email.toLowerCase(), String(Date.now()));
            // Store last normalized message to detect duplicates
            const msg = (form.querySelector('#message')?.value || '').trim().toLowerCase().replace(/\s+/g, ' ');
            localStorage.setItem('contactLastMsg:' + formType, msg);
        } catch {
            // ignore
        }
    }

    function isDuplicateMessage() {
        try {
            const last = localStorage.getItem('contactLastMsg:' + formType) || '';
            const cur = (form.querySelector('#message')?.value || '').trim().toLowerCase().replace(/\s+/g, ' ');
            return last && cur && last === cur;
        } catch {
            return false;
        }
    }

    async function send() {
        const body = buildBody();
        const start = performance.now();
        let res, raw;
        try {
            res = await fetch(FETCH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
                body,
                redirect: 'follow'
            });
            raw = await res.text();
        } catch (networkErr) {
            console.error('[ContactForm] Network error', networkErr);
            throw new Error('Network error – please check your connection.');
        }
        const duration = Math.round(performance.now() - start);
        console.log('[ContactForm] Response time:', duration + 'ms');
        console.log('[ContactForm] Raw response (first 200 chars):', raw.slice(0, 200));

        let json = null;
        try {
            json = JSON.parse(raw);
        } catch (parseErr) {
            console.warn('[ContactForm] Non-JSON response. Consider updating Apps Script to return JSON.', parseErr);
        }

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        // Strict path
        if (json && json.status && ['ok', 'success'].includes(String(json.status).toLowerCase())) {
            return json.message || 'Thank you! Your message has been sent.';
        }

        // Fallback: heuristics if server returns plain text that looks successful
        const lowered = raw.toLowerCase();
        if (!json && (lowered.includes('thank you') || lowered.includes('success'))) {
            console.warn('[ContactForm] Using fallback success detection. Please standardize server to return JSON {"status":"success"}.');
            return raw.slice(0, 140) || 'Thank you! Your message has been sent.';
        }

        throw new Error(json && json.message ? json.message : `Unexpected response (no success token): ${raw.slice(0, 140)}`);
    }

    // Show captcha widget only on supported hosts.
    try {
        if (captchaContainer && !turnstileEnabled) {
            captchaContainer.style.display = 'none';
        }
    } catch {
        // ignore
    }

    form.addEventListener('submit', async e => {
        e.preventDefault();
        if (busy) return;

        busy = true;
        toggle(true);
        setStatus('Sending...');
        track('form_submit_attempt', 'contact_form', 'start');

        const validationError = simpleValidate();
        if (validationError) {
            setStatus(validationError, true);
            track('form_submit', 'contact_form', 'validation_error');
            busy = false;
            toggle(false);
            return;
        }

        // Client rate-limits
        const email = form.querySelector('#email')?.value || '';
        if (tooSoonGlobal()) {
            setStatus('Please wait a moment before sending another message.', true);
            busy = false;
            toggle(false);
            return;
        }
        if (tooSoonByEmail(email)) {
            setStatus('You recently sent a message. Please try again later.', true);
            busy = false;
            toggle(false);
            return;
        }
        if (isDuplicateMessage()) {
            setStatus('This message appears to be a duplicate. Please modify it before sending.', true);
            busy = false;
            toggle(false);
            return;
        }

        // Optional CAPTCHA gate
        if (REQUIRE_CAPTCHA && turnstileEnabled) {
            const tsToken = document.querySelector('input[name="cf-turnstile-response"]')?.value;
            if (!tsToken) {
                setStatus('Please complete the verification before sending.', true);
                busy = false;
                toggle(false);
                return;
            }
        }

        try {
            const msg = await send();
            setStatus(msg, false);
            form.reset();
            recordSubmission(email);
            track('form_submit', 'contact_form', 'success');
        } catch (err) {
            console.error('[ContactForm]', err);
            setStatus(err.message || 'Submission failed.', true);
            track('form_submit', 'contact_form', 'failure');
        } finally {
            busy = false;
            toggle(false);
        }
    });
}

// Highlight current page in multi-page nav
function highlightCurrentPage() {
    const path = window.location.pathname.split('/').pop() || 'index.html';
    const navLinks = document.querySelectorAll('#primary-nav a');
    navLinks.forEach(link => {
        const href = link.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('http')) return;
        const target = href.split('/').pop();
        if ((path === '' && target === 'index.html') || path === target) {
            link.classList.add('active');
            link.setAttribute('aria-current', 'page');
        }
    });
}

// Smooth scrolling for navigation links
function initSmoothScrolling() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                const headerOffset = 80;
                const elementPosition = target.offsetTop;
                const offsetPosition = elementPosition - headerOffset;

                window.scrollTo({
                    top: offsetPosition,
                    behavior: 'smooth'
                });

                // Update active navigation
                updateActiveNavigation(this.getAttribute('href'));
            }
        });
    });
}

// Mobile menu functionality
function initMobileMenu() {
    const mobileMenuToggle = document.querySelector('.mobile-menu-toggle');
    const navMenu = document.querySelector('nav ul');
    
    if (mobileMenuToggle && navMenu) {
        // Initialize ARIA state
    navMenu.classList.remove('active');
    navMenu.setAttribute('aria-hidden', 'true');
        mobileMenuToggle.setAttribute('aria-expanded', 'false');
        mobileMenuToggle.addEventListener('click', function() {
            const isActive = navMenu.classList.toggle('active');
            this.setAttribute('aria-expanded', isActive);
            navMenu.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        });

        // Close mobile menu when clicking on a link
        navMenu.querySelectorAll('a').forEach(link => {
            link.addEventListener('click', () => {
                navMenu.classList.remove('active');
                mobileMenuToggle.setAttribute('aria-expanded', 'false');
            });
        });

        // Close mobile menu when clicking outside
    document.addEventListener('click', function(e) {
            // allow clicks on the toggle to pass through without closing
            if (!navMenu.contains(e.target) && !mobileMenuToggle.contains(e.target)) {
                navMenu.classList.remove('active');
                navMenu.setAttribute('aria-hidden', 'true');
                mobileMenuToggle.setAttribute('aria-expanded', 'false');
            }
        });

        // (Keyboard shortcut for closing via Escape removed)

        // Close on resize/orientation change to avoid stuck-open state
        window.addEventListener('resize', debounce(() => {
            if (navMenu.classList.contains('active')) {
                navMenu.classList.remove('active');
                navMenu.setAttribute('aria-hidden', 'true');
                mobileMenuToggle.setAttribute('aria-expanded', 'false');
            }
        }, 150));
        window.addEventListener('orientationchange', () => {
            if (navMenu.classList.contains('active')) {
                navMenu.classList.remove('active');
                navMenu.setAttribute('aria-hidden', 'true');
                mobileMenuToggle.setAttribute('aria-expanded', 'false');
            }
        });
    }
}

// Update active navigation based on scroll position
function updateActiveNavigation(activeHref = null) {
    const navLinks = document.querySelectorAll('nav a[href^="#"]');
    const sections = document.querySelectorAll('section[id]');
    
    if (activeHref) {
        // Remove active class from all links
        navLinks.forEach(link => { link.classList.remove('active'); link.removeAttribute('aria-current'); });
        // Add active class to clicked link
        const activeLink = document.querySelector(`nav a[href="${activeHref}"]`);
        if (activeLink) {
            activeLink.classList.add('active');
            activeLink.setAttribute('aria-current', 'true');
        }
        return;
    }

    // Automatic navigation update based on scroll
    let current = '';
    sections.forEach(section => {
        const sectionTop = section.offsetTop;
        const sectionHeight = section.clientHeight;
        if (pageYOffset >= sectionTop - 100) {
            current = section.getAttribute('id');
        }
    });

    navLinks.forEach(link => {
        link.classList.remove('active');
        link.removeAttribute('aria-current');
        if (link.getAttribute('href') === `#${current}`) {
            link.classList.add('active');
            link.setAttribute('aria-current', 'true');
        }
    });
}

// Enhanced form validation
function initFormValidation() {
    const contactForm = document.querySelector('.contact-form');
    if (!contactForm) return;

    const nameInput = contactForm.querySelector('#name');
    const emailInput = contactForm.querySelector('#email');
    const messageInput = contactForm.querySelector('#message');

    // Skip attaching submit handler if network handler attribute is present
    if (!contactForm.hasAttribute('data-no-script-handler')) {
        contactForm.addEventListener('submit', function(e) {
            e.preventDefault();
            let isValid = true;
            clearErrorMessages();
            if (!nameInput.value.trim() || nameInput.value.trim().length < 2) { showError(nameInput, 'Name is required (min 2 chars)'); isValid=false; }
            if (!emailInput.value.trim() || !isValidEmail(emailInput.value)) { showError(emailInput, 'Valid email required'); isValid=false; }
            if (!messageInput.value.trim() || messageInput.value.trim().length < 10) { showError(messageInput, 'Message must be at least 10 chars'); isValid=false; }
            if (isValid) { showSuccessMessage('Thank you for your message! We\'ll get back to you soon.'); trackEvent('form_submit','contact_form','success_no_net'); }
            else { trackEvent('form_submit','contact_form','validation_error'); }
        });
    }

    // Real-time validation
    [nameInput, emailInput, messageInput].forEach(input => {
        if (input) {
            input.addEventListener('blur', function() {
                validateSingleField(this);
            });
            
            input.addEventListener('input', function() {
                clearFieldError(this);
            });
        }
    });
}

function validateSingleField(field) {
    const value = field.value.trim();
    
    switch(field.type) {
        case 'text':
            if (field.id === 'name' && value.length > 0 && value.length < 2) {
                showError(field, 'Name must be at least 2 characters');
            }
            break;
        case 'email':
            if (value.length > 0 && !isValidEmail(value)) {
                showError(field, 'Please enter a valid email address');
            }
            break;
    }
    
    if (field.tagName === 'TEXTAREA' && value.length > 0 && value.length < 10) {
        showError(field, 'Message must be at least 10 characters');
    }
}

function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

function showError(field, message) {
    clearFieldError(field);
    
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error-message';
    errorDiv.textContent = message;
    const errorId = (field.id ? `${field.id}-error` : `field-error-${Date.now()}`);
    errorDiv.id = errorId;
    errorDiv.setAttribute('role', 'alert');
    errorDiv.style.color = '#dc3545';
    errorDiv.style.fontSize = '0.875rem';
    errorDiv.style.marginTop = '0.25rem';
    
    field.parentNode.appendChild(errorDiv);
    field.style.borderColor = '#dc3545';
    field.setAttribute('aria-invalid', 'true');
    addAriaDescribedBy(field, errorId);
    // Announce error to screen readers
    const status = document.getElementById('contact-form-status');
    if (status) {
        status.textContent = message;
    }
}

function clearFieldError(field) {
    const existingError = field.parentNode.querySelector('.error-message');
    if (existingError) {
        if (existingError.id) removeAriaDescribedBy(field, existingError.id);
        existingError.remove();
    }
    field.style.borderColor = '';
    field.removeAttribute('aria-invalid');
}

function clearErrorMessages() {
    document.querySelectorAll('.error-message').forEach(error => error.remove());
    document.querySelectorAll('.success-message').forEach(success => success.remove());

    // Clear any lingering aria-invalid/aria-describedby error references
    document.querySelectorAll('.contact-form [aria-invalid="true"]').forEach(el => {
        el.removeAttribute('aria-invalid');
    });
    document.querySelectorAll('.contact-form [aria-describedby]').forEach(el => {
        const cur = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
        const next = cur.filter(t => !t.endsWith('-error'));
        if (next.length) el.setAttribute('aria-describedby', next.join(' '));
        else el.removeAttribute('aria-describedby');
    });
}

function addAriaDescribedBy(el, id) {
    const cur = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!cur.includes(id)) cur.push(id);
    el.setAttribute('aria-describedby', cur.join(' '));
}

function removeAriaDescribedBy(el, id) {
    const cur = (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    const next = cur.filter(t => t !== id);
    if (next.length) el.setAttribute('aria-describedby', next.join(' '));
    else el.removeAttribute('aria-describedby');
}

function showSuccessMessage(message) {
    clearErrorMessages();
    
    const successDiv = document.createElement('div');
    successDiv.className = 'success-message';
    successDiv.textContent = message;
    successDiv.style.color = '#28a745';
    successDiv.style.fontWeight = '600';
    successDiv.style.marginBottom = '1rem';
    successDiv.style.padding = '1rem';
    successDiv.style.backgroundColor = '#d4edda';
    successDiv.style.border = '1px solid #c3e6cb';
    successDiv.style.borderRadius = '0.375rem';
    
    const form = document.querySelector('.contact-form');
    form.insertBefore(successDiv, form.firstChild);
    // Announce success to screen readers
    const status = document.getElementById('contact-form-status');
    if (status) {
        status.textContent = message;
    }
    
    // Remove success message after 5 seconds
    setTimeout(() => {
        successDiv.remove();
    }, 5000);
}

// Enhanced image modal/lightbox
function initImageModal() {
    const galleryImages = document.querySelectorAll('.event-gallery img, .hero-image');
    
    if (galleryImages.length === 0) return;

    // Create modal elements
    const modal = createModal();
    document.body.appendChild(modal);

    const modalImg = modal.querySelector('.modal-image');
    const closeBtn = modal.querySelector('.modal-close');
    const prevBtn = modal.querySelector('.modal-prev');
    const nextBtn = modal.querySelector('.modal-next');
    
    let currentImageIndex = 0;
    const images = Array.from(galleryImages);

    // Add click event to images
    galleryImages.forEach((img, index) => {
        img.style.cursor = 'pointer';
        img.addEventListener('click', function() {
            currentImageIndex = index;
            openModal(this.src, this.alt);
        });
    });

    function openModal(src, alt) {
        modal.style.display = 'block';
        modalImg.src = src;
        modalImg.alt = alt;
        document.body.style.overflow = 'hidden';
        
        // Update navigation buttons
        updateNavigationButtons();
        
        trackEvent('image_view', 'modal', src);
    }

    function closeModal() {
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }

    function updateNavigationButtons() {
        prevBtn.style.display = images.length > 1 ? 'block' : 'none';
        nextBtn.style.display = images.length > 1 ? 'block' : 'none';
    }

    // Event listeners
    closeBtn.addEventListener('click', closeModal);
    
    prevBtn.addEventListener('click', function() {
        currentImageIndex = (currentImageIndex - 1 + images.length) % images.length;
        const prevImage = images[currentImageIndex];
        modalImg.src = prevImage.src;
        modalImg.alt = prevImage.alt;
    });
    
    nextBtn.addEventListener('click', function() {
        currentImageIndex = (currentImageIndex + 1) % images.length;
        const nextImage = images[currentImageIndex];
        modalImg.src = nextImage.src;
        modalImg.alt = nextImage.alt;
    });

    // Close modal when clicking outside image
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            closeModal();
        }
    });

    // Removed keyboard navigation (Arrow/Escape) for modal per request
}

function createModal() {
    const modal = document.createElement('div');
    modal.className = 'image-modal';
    modal.innerHTML = `
        <div class="modal-content">
            <span class="modal-close">&times;</span>
            <img class="modal-image" src="" alt="">
            <button class="modal-nav modal-prev">&#10094;</button>
            <button class="modal-nav modal-next">&#10095;</button>
        </div>
    `;
    
    // Add styles
    const style = document.createElement('style');
    style.textContent = `
        .image-modal {
            display: none;
            position: fixed;
            z-index: 2000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.9);
            animation: fadeIn 0.3s ease;
        }
        
        @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
        }
        
        .modal-content {
            position: relative;
            margin: auto;
            display: block;
            width: 90%;
            max-width: 1200px;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
        }
        
        .modal-image {
            max-width: 100%;
            max-height: 90%;
            object-fit: contain;
        }
        
        .modal-close {
            position: absolute;
            top: 20px;
            right: 35px;
            color: #f1f1f1;
            font-size: 40px;
            font-weight: bold;
            cursor: pointer;
            z-index: 2001;
        }
        
        .modal-close:hover {
            color: #ffd700;
        }
        
        .modal-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            background-color: rgba(0,0,0,0.5);
            color: white;
            border: none;
            padding: 16px;
            font-size: 18px;
            cursor: pointer;
            z-index: 2001;
        }
        
        .modal-prev {
            left: 20px;
        }
        
        .modal-next {
            right: 20px;
        }
        
        .modal-nav:hover {
            background-color: rgba(0,0,0,0.8);
        }
        
        @media (max-width: 768px) {
            .modal-close {
                top: 10px;
                right: 20px;
                font-size: 30px;
            }
            
            .modal-nav {
                padding: 12px;
                font-size: 16px;
            }
        }
    `;
    document.head.appendChild(style);
    
    return modal;
}

// Scroll animations
function initScrollAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -100px 0px'
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-in');
                
                // Animate statistics counters
                if (entry.target.classList.contains('stat-item')) {
                    animateCounter(entry.target);
                }
            }
        });
    }, observerOptions);

    // Observe elements for animation
    document.querySelectorAll('.program-card, .event-card, .stat-item, .impact-item, .testimonial').forEach(el => {
        observer.observe(el);
    });

    // Add CSS for animations
    const style = document.createElement('style');
    style.textContent = `
        .program-card, .event-card, .stat-item, .impact-item, .testimonial {
            opacity: 0;
            transform: translateY(30px);
            transition: opacity 0.6s ease, transform 0.6s ease;
        }
        
        .program-card.animate-in, .event-card.animate-in, .stat-item.animate-in, 
        .impact-item.animate-in, .testimonial.animate-in {
            opacity: 1;
            transform: translateY(0);
        }
        
        .stat-item.animate-in {
            animation: slideInUp 0.8s ease forwards;
        }
        
        @keyframes slideInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    `;
    document.head.appendChild(style);
}

function animateCounter(element) {
    const numberElement = element.querySelector('.stat-number');
    if (!numberElement || numberElement.dataset.animated) return;
    
    const finalNumber = parseInt(numberElement.textContent.replace(/\D/g, ''));
    const duration = 2000;
    const increment = finalNumber / (duration / 16);
    let current = 0;
    
    const timer = setInterval(() => {
        current += increment;
        if (current >= finalNumber) {
            current = finalNumber;
            clearInterval(timer);
        }
        
        const suffix = numberElement.textContent.includes('%') ? '%' : 
                      numberElement.textContent.includes('+') ? '+' : '';
        numberElement.textContent = Math.floor(current) + suffix;
    }, 16);
    
    numberElement.dataset.animated = 'true';
}

// Lazy loading for images
function initLazyLoading() {
    const lazyImages = document.querySelectorAll('img[loading="lazy"]');
    
    if ('IntersectionObserver' in window) {
        const imageObserver = new IntersectionObserver(function(entries) {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    img.classList.add('loaded');
                    imageObserver.unobserve(img);
                }
            });
        });

        lazyImages.forEach(img => imageObserver.observe(img));
    } else {
        // Fallback for older browsers
        lazyImages.forEach(img => img.classList.add('loaded'));
    }
}

// Analytics and tracking
function initAnalytics() {
    // Track page load
    trackEvent('page_load', 'website', window.location.pathname);
    
    // Track scroll depth
    let maxScroll = 0;
    window.addEventListener('scroll', debounce(() => {
        const scrollPercent = Math.round((window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100);
        if (scrollPercent > maxScroll) {
            maxScroll = scrollPercent;
            if (maxScroll >= 25 && maxScroll < 50) {
                trackEvent('scroll_depth', '25_percent', maxScroll);
            } else if (maxScroll >= 50 && maxScroll < 75) {
                trackEvent('scroll_depth', '50_percent', maxScroll);
            } else if (maxScroll >= 75) {
                trackEvent('scroll_depth', '75_percent', maxScroll);
            }
        }
    }, 250));
    
    // Track button clicks
    document.querySelectorAll('.btn').forEach(btn => {
        btn.addEventListener('click', function() {
            trackEvent('button_click', this.className, this.textContent.trim());
        });
    });
    
    // Track navigation updates
    window.addEventListener('scroll', debounce(updateActiveNavigation, 100));
}

function trackEvent(action, category, label) {
    // This would integrate with Google Analytics, Facebook Pixel, or other analytics
    console.log('Analytics Event:', { action, category, label });
    
    // Example integration with Google Analytics (if gtag is available)
    if (typeof gtag !== 'undefined') {
        gtag('event', action, {
            event_category: category,
            event_label: label
        });
    }
}

// Utility function for debouncing
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Performance optimization
window.addEventListener('load', function() {
    // Remove loading classes and show content
    document.body.classList.add('loaded');
});

// Error handling
window.addEventListener('error', function(e) {
    console.error('JavaScript error:', e.error);
    trackEvent('javascript_error', e.filename, e.message);
});

// Service Worker registration for improved performance (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        navigator.serviceWorker.register('/sw.js')
            .then(registration => console.log('SW registered'))
            .catch(error => console.log('SW registration failed'));
    });
}

// Event Tabs Functionality
function initEventTabs() {
    const eventTabs = document.querySelectorAll('.event-tab');
    const eventDetails = document.querySelectorAll('.event-details');
    
    if (eventTabs.length === 0) return;
    
    // Initialize the photo arrays first
    initEventPhotos();
    // Initialize ARIA states and roving tabindex for tabs
    eventTabs.forEach((t, i) => {
        const selected = t.classList.contains('active');
        t.setAttribute('role', 'tab');
        t.setAttribute('aria-selected', selected ? 'true' : 'false');
        t.setAttribute('tabindex', selected ? '0' : '-1');
    });
    eventDetails.forEach(panel => {
        const active = panel.classList.contains('active');
        panel.setAttribute('role', 'tabpanel');
        if (!active) panel.setAttribute('hidden', '');
    });
    
    eventTabs.forEach(tab => {
        tab.addEventListener('click', function() {
            const eventType = this.getAttribute('data-event');
            
            console.log('🔄 Switching to event tab:', eventType);
            
            // Remove active class from all tabs and details
            eventTabs.forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-selected', 'false');
                t.setAttribute('tabindex', '-1');
            });
            eventDetails.forEach(d => {
                d.classList.remove('active');
                d.setAttribute('hidden', '');
            });
            
            // Clear all gallery loaded states to force refresh
            document.querySelectorAll('.gallery-grid').forEach(grid => {
                grid.dataset.loaded = 'false';
            });
            
            // Add active class to clicked tab and corresponding content
            this.classList.add('active');
            this.setAttribute('aria-selected', 'true');
            this.removeAttribute('tabindex');
            const targetContent = document.getElementById(`${eventType}-content`);
            if (targetContent) {
                targetContent.classList.add('active');
                targetContent.removeAttribute('hidden');
                
                // Force load gallery (auto scroll disabled to prevent jump away from hero)
                setTimeout(() => {
                    loadEventGallery(eventType, { scroll: true });
                    // Disabled automatic scroll helper kept for reference
                    // setTimeout(() => { scrollToGallery(eventType); }, 200);
                }, 100);
            }
            
            // Track tab click
            trackEvent('event_tab_click', 'events', eventType);
        });
        // Removed keyboard navigation for tabs
    });
    
    // Default gallery is already loaded in the main initialization
}

// Smooth scroll to center gallery in viewport
function scrollToGallery(eventType) {
    console.log('📍 Scrolling to gallery:', eventType);
    
    const galleryElement = document.getElementById(`${eventType}-gallery`);
    if (!galleryElement) {
        console.warn('Gallery element not found:', eventType);
        return;
    }
    
    // Calculate the position to center the gallery in viewport
    const galleryRect = galleryElement.getBoundingClientRect();
    const viewportHeight = window.innerHeight;
    const galleryHeight = galleryRect.height;
    
    // Calculate scroll position to center the gallery
    const currentScrollTop = window.pageYOffset || document.documentElement.scrollTop;
    const galleryTop = galleryRect.top + currentScrollTop;
    const centerPosition = galleryTop - (viewportHeight - galleryHeight) / 2;
    
    // Ensure we don't scroll above the top of the page
    const scrollPosition = Math.max(0, centerPosition);
    
    // Smooth scroll to the calculated position
    window.scrollTo({
        top: scrollPosition,
        behavior: 'smooth'
    });
}

// Event Galleries Functionality
function initEventPhotos() {
    console.log('🎯 Initializing event photos...');
    
    // Define photo collections for each event using optimized medium-sized images
    window.eventPhotos = {
        mmhe: [
            // Only the 4 remaining medium webp images in mmhe
            'photos/mmhe/IMG_3804_medium.webp',
            'photos/mmhe/IMG_3809_medium.webp',
            'photos/mmhe/IMG_3821_medium.webp',
            'photos/mmhe/IMG_3891_medium.webp'
        ],
        discpan: [
            // Only the 4 remaining medium webp images in discpan
            'photos/discpan/9-_DSC1415_medium.webp',
            'photos/discpan/14-_DSC1425_medium.webp',
            'photos/discpan/21-_DSC1446_medium.webp',
            'photos/discpan/23-_DSC1459_medium.webp'
        ]
    };
    
    console.log('✅ Event photos initialized:', {
        mmhe: window.eventPhotos.mmhe.length,
        discpan: window.eventPhotos.discpan.length
    });
}

function loadEventGallery(eventType, options = {}) {
    const { scroll = false } = options;
    const galleryContainer = document.querySelector(`#${eventType}-gallery .gallery-grid`);
    const paginationContainer = document.querySelector(`#${eventType}-pagination`);
    if (!galleryContainer) return;
    
    console.log('🖼️ Loading gallery for:', eventType);
    
    // Check if gallery is already loaded
    if (galleryContainer.dataset.loaded === 'true') {
        console.log('Gallery already loaded for:', eventType);
        return;
    }
    
    // Show loading state
    galleryContainer.innerHTML = '<div class="gallery-loading">Loading photos...</div>';
    
    // Get photos for this event
    const photos = window.eventPhotos ? window.eventPhotos[eventType] : [];
    
    console.log('Photos found for', eventType, ':', photos.length);
    console.log('First 3 photos:', photos.slice(0, 3));
    
    if (!photos || photos.length === 0) {
        // Show empty state
        galleryContainer.innerHTML = `
            <div class="gallery-empty">
                <h4>Coming Soon</h4>
                <p>Photos from this event will be available soon.</p>
            </div>
        `;
        return;
    }
    
    // Initialize pagination for this event
    initGalleryPagination(eventType, photos);
    
    // Mark as loaded and store scroll preference
    galleryContainer.dataset.loaded = 'true';
    galleryContainer.dataset.shouldScroll = scroll ? 'true' : 'false';
}

// Gallery Pagination System
function initGalleryPagination(eventType, photos) {
    // With fewer images now, show all photos in one view without pagination
    const PHOTOS_PER_PAGE = photos.length; // Show all photos at once
    const totalPages = Math.ceil(photos.length / PHOTOS_PER_PAGE);
    
    // Initialize pagination state
    if (!window.galleryPagination) {
        window.galleryPagination = {};
    }
    
    window.galleryPagination[eventType] = {
        currentPage: 1,
        totalPages: totalPages,
        photos: photos,
        photosPerPage: PHOTOS_PER_PAGE
    };
    
    // Setup pagination controls
    setupPaginationControls(eventType);
    
    // Load first page
    loadGalleryPage(eventType, 1);
}

function setupPaginationControls(eventType) {
    const pagination = window.galleryPagination[eventType];
    const paginationContainer = document.querySelector(`#${eventType}-pagination`);
    const prevBtn = document.querySelector(`#${eventType}-prev`);
    const nextBtn = document.querySelector(`#${eventType}-next`);
    const pageInfo = document.querySelector(`#${eventType}-page-info`);
    
    if (!paginationContainer) return;
    
    // Hide pagination since we're showing all photos in one view
    if (pagination.totalPages > 1) {
        paginationContainer.classList.add('hidden'); // Always hide pagination now
        
    // Removed keyboard shortcuts info injection
    }
    
    // Update page info
    if (pageInfo) {
        pageInfo.textContent = `Page ${pagination.currentPage} of ${pagination.totalPages}`;
    }
    
    // Setup button event listeners
    if (prevBtn) {
        prevBtn.addEventListener('click', () => {
            if (pagination.currentPage > 1) {
                loadGalleryPage(eventType, pagination.currentPage - 1);
            }
        });
    }
    
    if (nextBtn) {
        nextBtn.addEventListener('click', () => {
            if (pagination.currentPage < pagination.totalPages) {
                loadGalleryPage(eventType, pagination.currentPage + 1);
            }
        });
    }
    
    // Update button states
    updatePaginationButtons(eventType);
}

// Removed addKeyboardShortcutsInfo function (no longer needed)

function loadGalleryPage(eventType, pageNumber) {
    const pagination = window.galleryPagination[eventType];
    const galleryContainer = document.querySelector(`#${eventType}-gallery .gallery-grid`);
    
    if (!pagination || !galleryContainer) return;
    
    // Add transition effect and announce busy state
    const galleryRegion = document.querySelector(`#${eventType}-gallery`);
    if (galleryRegion) {
        galleryRegion.setAttribute('aria-busy', 'true');
    }
    // Add transition effect
    galleryContainer.classList.add('page-transition');
    
    setTimeout(() => {
        // Update current page
        pagination.currentPage = pageNumber;
        
        // Calculate photo range for this page
        const startIndex = (pageNumber - 1) * pagination.photosPerPage;
        const endIndex = Math.min(startIndex + pagination.photosPerPage, pagination.photos.length);
        const pagePhotos = pagination.photos.slice(startIndex, endIndex);
        
        // Clear gallery
        galleryContainer.innerHTML = '';
        // Mark container as a list for accessibility
        galleryContainer.setAttribute('role', 'list');
        
        // Create gallery items for current page
        pagePhotos.forEach((photoUrl, index) => {
            const actualIndex = startIndex + index;
            const galleryItem = document.createElement('div');
            galleryItem.className = 'gallery-item';
            galleryItem.dataset.eventType = eventType;
            galleryItem.dataset.photoIndex = actualIndex;
            galleryItem.setAttribute('role', 'listitem');

            // Use thumbnail for display, but open medium in modal
            const thumbUrl = photoUrl.replace('_medium.webp', '_thumbnail.webp');
            const thumbJpegUrl = photoUrl.replace('_medium.webp', '_thumbnail.jpeg');
            const mediumJpegUrl = photoUrl.replace('_medium.webp', '_medium.jpeg');

            // Create picture element with WebP and JPEG fallback for thumbnail
            const picture = document.createElement('picture');

            // WebP source (thumbnail)
            const webpSource = document.createElement('source');
            webpSource.srcset = `${thumbUrl} 1x, ${photoUrl} 2x`;
            webpSource.type = 'image/webp';

            // JPEG fallback (thumbnail)
            const jpegSource = document.createElement('source');
            jpegSource.srcset = `${thumbJpegUrl} 1x, ${mediumJpegUrl} 2x`;
            jpegSource.type = 'image/jpeg';

            // Main img element (fallback, thumbnail)
            const img = document.createElement('img');
            img.src = thumbJpegUrl;
            img.alt = `${getEventName(eventType)} 2024`;
            img.loading = 'lazy';
            img.decoding = 'async';
            img.width = 300;
            img.height = 300;
            img.sizes = '(max-width: 480px) 45vw, (max-width: 900px) 30vw, 300px';

            // Append sources to picture
            picture.appendChild(webpSource);
            picture.appendChild(jpegSource);
            picture.appendChild(img);

            // Create overlay for styling
            const overlay = document.createElement('div');
            overlay.className = 'gallery-overlay';

            const caption = document.createElement('div');
            caption.className = 'gallery-caption';
            caption.textContent = `${getEventName(eventType)} 2024`;

            overlay.appendChild(caption);

            img.addEventListener('error', function() {
                galleryItem.innerHTML = `
                    <div class="gallery-placeholder">
                        <div class="placeholder-content">
                            <h4>${getEventName(eventType)} 2024</h4>
                            <p>Image not available</p>
                        </div>
                    </div>
                `;
                galleryItem.classList.add('placeholder');
            });

            img.addEventListener('load', function() {
                // Mark as loaded so CSS fades it in
                img.classList.add('loaded');
                galleryItem.addEventListener('click', function() {
                    openImageModal(photoUrl, img.alt, eventType, actualIndex);
                });
            });

            galleryItem.appendChild(picture);
            galleryItem.appendChild(overlay);
            galleryContainer.appendChild(galleryItem);

            // Add entrance animation
            galleryItem.classList.add('loading');
            setTimeout(() => {
                galleryItem.classList.remove('loading');
                galleryItem.classList.add('animate-in');
            }, index * 50);
        });
        
    // Re-attach lazy loading to any new images just added
    initLazyLoading();

    // Remove transition effect and add loaded state
        galleryContainer.classList.remove('page-transition');
        galleryContainer.classList.add('page-loaded');
        
    // Update pagination controls
        updatePaginationButtons(eventType);
        updatePageInfo(eventType);
        
        // Re-initialize image modal for new images
        initGalleryImageModal();
        
        // Conditional scroll only if user initiated and requested
        const gallerySection = document.querySelector(`#${eventType}-gallery`);
        if (gallerySection) {
            const shouldScroll = galleryContainer && galleryContainer.dataset.shouldScroll === 'true';
            if (shouldScroll) {
                gallerySection.scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'nearest'
                });
            }
            gallerySection.setAttribute('aria-busy', 'false');
        }
    }, 150); // Small delay for smooth transition
}

function updatePaginationButtons(eventType) {
    const pagination = window.galleryPagination[eventType];
    const prevBtn = document.querySelector(`#${eventType}-prev`);
    const nextBtn = document.querySelector(`#${eventType}-next`);
    
    if (prevBtn) {
        prevBtn.disabled = pagination.currentPage <= 1;
    }
    
    if (nextBtn) {
        nextBtn.disabled = pagination.currentPage >= pagination.totalPages;
    }
}

function updatePageInfo(eventType) {
    const pagination = window.galleryPagination[eventType];
    const pageInfo = document.querySelector(`#${eventType}-page-info`);
    
    if (pageInfo) {
        pageInfo.textContent = `Page ${pagination.currentPage} of ${pagination.totalPages}`;
    }
}

function getEventName(eventType) {
    const names = {
        mmhe: "Men's Mental Health Expo",
        discpan: "Discussion Panel",
        erf: "Ed Reed Foundation"
    };
    return names[eventType] || eventType;
}

// Enhanced Image Modal for Gallery
function initGalleryImageModal() {
    // Remove existing modal if present
    const existingModal = document.querySelector('.gallery-modal');
    if (existingModal) {
        existingModal.remove();
    }
    
    // Create new modal
    const modal = createGalleryModal();
    document.body.appendChild(modal);
    
    const modalImg = modal.querySelector('.modal-image');
    const modalCaption = modal.querySelector('.modal-caption');
    const closeBtn = modal.querySelector('.modal-close');
    const prevBtn = modal.querySelector('.modal-prev');
    const nextBtn = modal.querySelector('.modal-next');
    const counter = modal.querySelector('.modal-counter');
    
    let currentEvent = '';
    let currentIndex = 0;
    let currentPhotos = [];
    
    // Event listeners
    closeBtn.addEventListener('click', closeGalleryModal);
    prevBtn.addEventListener('click', showPreviousImage);
    nextBtn.addEventListener('click', showNextImage);
    
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            closeGalleryModal();
        }
    });
    
    // Removed keyboard event listeners for gallery modal
    
    function openImageModal(src, alt, eventType, index) {
        currentEvent = eventType;
        currentIndex = index;
        currentPhotos = window.eventPhotos[eventType] || [];
        
        modal.style.display = 'block';
        modal.setAttribute('aria-hidden', 'false');
        modalImg.src = src;
        modalImg.alt = alt;
        modalCaption.textContent = alt;
        updateCounter();
        updateNavigationButtons();
        // Save last focused element and trap focus inside modal
        modal._lastFocus = document.activeElement;
        document.body.style.overflow = 'hidden';
        const focusable = [closeBtn, prevBtn, nextBtn];
        // Ensure buttons are focusable
        focusable.forEach(el => el && el.setAttribute('tabindex', '0'));
        closeBtn.focus();
        const trapFocus = (e) => {
            if (e.key !== 'Tab') return;
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first.focus();
            }
        };
        modal.addEventListener('keydown', trapFocus);
        modal._trap = trapFocus;
        
        trackEvent('gallery_image_view', 'events', `${eventType}_${index}`);
    }
    
    function closeGalleryModal() {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
        document.body.style.overflow = '';
        if (modal._trap) {
            modal.removeEventListener('keydown', modal._trap);
            modal._trap = null;
        }
        if (modal._lastFocus && typeof modal._lastFocus.focus === 'function') {
            modal._lastFocus.focus();
            modal._lastFocus = null;
        }
    }
    
    function showPreviousImage() {
        if (currentPhotos.length <= 1) return;
        
        currentIndex = (currentIndex - 1 + currentPhotos.length) % currentPhotos.length;
        updateModalImage();
    }
    
    function showNextImage() {
        if (currentPhotos.length <= 1) return;
        
        currentIndex = (currentIndex + 1) % currentPhotos.length;
        updateModalImage();
    }
    
    function updateModalImage() {
        const newSrc = currentPhotos[currentIndex];
        const newAlt = `${getEventName(currentEvent)} 2024`;
        
        modalImg.src = newSrc;
        modalImg.alt = newAlt;
        modalCaption.textContent = newAlt;
        updateCounter();
    }
    
    function updateCounter() {
        if (counter && currentPhotos.length > 1) {
            counter.textContent = `${currentIndex + 1} / ${currentPhotos.length}`;
            counter.style.display = 'block';
        } else if (counter) {
            counter.style.display = 'none';
        }
    }
    
    function updateNavigationButtons() {
        const hasMultipleImages = currentPhotos.length > 1;
        prevBtn.style.display = hasMultipleImages ? 'block' : 'none';
        nextBtn.style.display = hasMultipleImages ? 'block' : 'none';
    }
    
    // Make openImageModal globally accessible
    window.openImageModal = openImageModal;
}

function createGalleryModal() {
    const modal = document.createElement('div');
    modal.className = 'gallery-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
        <div class="modal-content">
            <span class="modal-close" aria-label="Close image viewer" tabindex="0">&times;</span>
            <img id="gallery-modal-image" class="modal-image" src="" alt="">
            <div id="gallery-modal-caption" class="modal-caption"></div>
            <div class="modal-counter" aria-live="polite"></div>
            <button class="modal-nav modal-prev" aria-label="Previous image">&#10094;</button>
            <button class="modal-nav modal-next" aria-label="Next image">&#10095;</button>
        </div>
    `;
    
    // Add styles for the gallery modal
    const style = document.createElement('style');
    style.textContent = `
        .gallery-modal {
            display: none;
            position: fixed;
            z-index: 2000;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.95);
            animation: fadeIn 0.3s ease;
        }
        
        .gallery-modal .modal-content {
            position: relative;
            margin: auto;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 90%;
            max-width: 1200px;
            height: 100%;
            flex-direction: column;
        }
        
        .gallery-modal .modal-image {
            max-width: 90%;
            max-height: 80%;
            object-fit: contain;
            border-radius: 8px;
        }
        
        .modal-caption {
            color: white;
            text-align: center;
            margin-top: 1rem;
            font-size: 1.1rem;
            font-weight: 600;
        }
        
        .modal-counter {
            color: white;
            text-align: center;
            margin-top: 0.5rem;
            font-size: 0.9rem;
            opacity: 0.8;
        }
        
        .gallery-modal .modal-close {
            position: absolute;
            top: 20px;
            right: 35px;
            color: #f1f1f1;
            font-size: 40px;
            font-weight: bold;
            cursor: pointer;
            z-index: 2001;
            transition: color 0.3s ease;
        }
        
        .gallery-modal .modal-close:hover {
            color: var(--secondary-color);
        }
        
        .gallery-modal .modal-nav {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            background-color: rgba(0,0,0,0.5);
            color: white;
            border: none;
            padding: 16px;
            font-size: 18px;
            cursor: pointer;
            z-index: 2001;
            border-radius: 4px;
            transition: background-color 0.3s ease;
        }
        
        .gallery-modal .modal-prev {
            left: 20px;
        }
        
        .gallery-modal .modal-next {
            right: 20px;
        }
        
        .gallery-modal .modal-nav:hover {
            background-color: rgba(0,0,0,0.8);
        }
        
        .gallery-placeholder {
            background-color: var(--background-light);
            border: 2px dashed var(--border-color);
            border-radius: var(--border-radius);
            height: 200px;
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--text-light);
        }
        
        .placeholder-content {
            text-align: center;
        }
        
        .placeholder-content h4 {
            color: var(--primary-color);
            margin-bottom: 0.5rem;
        }
        
        @media (max-width: 768px) {
            .gallery-modal .modal-close {
                top: 10px;
                right: 20px;
                font-size: 30px;
            }
            
            .gallery-modal .modal-nav {
                padding: 12px;
                font-size: 16px;
            }
            
            .gallery-modal .modal-image {
                max-height: 70%;
            }
        }
        
        .gallery-item.animate-in {
            animation: slideInUp 0.6s ease forwards;
        }
        
        @keyframes slideInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }
    `;
    document.head.appendChild(style);
    
    return modal;
}

// Prefetch remaining images for better performance
function prefetchEventImages() {
    if (!window.eventPhotos) return;
    
    // Prefetch remaining MMHE images (after first 6)
    const mmheImages = window.eventPhotos.mmhe.slice(6);
    mmheImages.forEach(imageUrl => {
        const img = new Image();
        img.src = imageUrl;
    });
    
    // Prefetch other event images
    ['discpan'].forEach(eventType => {
        const images = window.eventPhotos[eventType];
        if (images) {
            images.forEach(imageUrl => {
                const img = new Image();
                img.src = imageUrl;
            });
        }
    });
}

// Initial prefetch
prefetchEventImages();

// Removed initKeyboardNavigation and associated global key handlers
// Removed donate modal functionality in favor of direct external donate link
