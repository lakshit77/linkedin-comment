/**
 * LinkedIn Comment Generator - Popup Script
 */
document.addEventListener('DOMContentLoaded', function() {
    const postContent = document.getElementById('postContent');
    const hintInput = document.getElementById('hintInput');
    const commentBox = document.getElementById('commentBox');
    const regenerateBtn = document.getElementById('regenerateBtn');
    const confirmBtn = document.getElementById('confirmBtn');
    const loading = document.getElementById('loading');
    const error = document.getElementById('error');

    let currentPost = null;
    let currentCaption = null;
    let currentComment = null;

    function updatePostPreview(content, caption) {
        if (!content) {
            postContent.innerHTML = '<div class="no-post">Select a post to generate a comment</div>';
            return;
        }
        let previewHtml = '';
        if (caption) {
            previewHtml += `<div class="caption">${caption}</div>`;
        }
        previewHtml += `<div class="content">${content.substring(0, 200)}${content.length > 200 ? '...' : ''}</div>`;
        postContent.innerHTML = previewHtml;
    }

    function showLoading() {
        if (loading) loading.style.display = 'block';
        if (commentBox) commentBox.style.display = 'none';
        if (regenerateBtn) regenerateBtn.disabled = true;
        if (confirmBtn) confirmBtn.disabled = true;
        if (error) error.style.display = 'none';
    }

    function hideLoading() {
        if (loading) loading.style.display = 'none';
        if (commentBox) commentBox.style.display = 'block';
        if (regenerateBtn) regenerateBtn.disabled = false;
        if (confirmBtn) confirmBtn.disabled = false;
    }

    function showError(message) {
        if (error) {
            error.textContent = message;
            error.style.display = 'block';
        }
    }

    // Content script ko message bhejne ka helper (auto-inject fallback ke saath)
    async function sendMessageToContentScript(tabId, message) {
        try {
            return await chrome.tabs.sendMessage(tabId, message);
        } catch (err) {
            // Agar content script load nahi hui hai toh use auto-inject karein
            await chrome.scripting.executeScript({
                target: { tabId: tabId },
                files: ['content.js']
            });
            await new Promise(r => setTimeout(r, 500));
            return await chrome.tabs.sendMessage(tabId, message);
        }
    }

    async function generateComment() {
        if (!currentPost) {
            showError('No post selected');
            return;
        }

        showLoading();

        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            const hint = hintInput ? hintInput.value.trim() : '';

            const response = await sendMessageToContentScript(tab.id, {
                action: 'generateComment',
                content: currentPost,
                caption: currentCaption,
                hint: hint
            });

            if (response && response.success && response.comment) {
                currentComment = response.comment;
                commentBox.value = currentComment;
            } else {
                showError((response && response.error) || 'Failed to generate comment');
            }
            hideLoading();
        } catch (err) {
            console.error('[LinkedIn Comment Generator] Error generating comment', err);
            showError('Failed to generate comment. Please try again.');
            hideLoading();
        }
    }

    async function copyCommentToClipboard() {
        if (!currentComment) {
            showError('No comment generated yet');
            return;
        }
        try {
            await navigator.clipboard.writeText(currentComment);
            const originalText = confirmBtn.textContent;
            confirmBtn.textContent = 'Copied!';
            setTimeout(() => {
                confirmBtn.textContent = originalText;
            }, 2000);
        } catch (err) {
            console.error('[LinkedIn Comment Generator] Error copying to clipboard', err);
            showError('Failed to copy comment. Please try again.');
        }
    }

    if (regenerateBtn) regenerateBtn.addEventListener('click', generateComment);
    if (confirmBtn) confirmBtn.addEventListener('click', copyCommentToClipboard);
    if (hintInput) {
        hintInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                generateComment();
            }
        });
    }

    async function initialize() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !tab.url || !tab.url.includes('linkedin.com')) {
                showError('Please navigate to LinkedIn to use this extension');
                return;
            }

            const response = await sendMessageToContentScript(tab.id, {
                action: 'getSelectedPost'
            });

            if (response && response.success && response.content) {
                currentPost = response.content;
                currentCaption = response.caption;
                updatePostPreview(currentPost, currentCaption);
                generateComment();
            } else {
                updatePostPreview(null, null);
                showError('No LinkedIn post found. Scroll to a post and try again.');
            }
        } catch (err) {
            console.error('[LinkedIn Comment Generator] Error initializing popup', err);
            showError('Failed to connect to LinkedIn page. Please refresh LinkedIn and try again.');
        }
    }

    initialize();
});