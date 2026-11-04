/**
 * LinkedIn Comment Generator - Background Script
 */
const logger = {
    enabled: false,
    log(message, data = null) {
        if (this.enabled) {
            console.log(`[LinkedIn Comment Generator] ${message}`, data || '');
        }
    },
    error(message, error = null) {
        console.error(`[LinkedIn Comment Generator] ${message}`, error || '');
    }
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    logger.log('Received message', request);

    try {
        if (request.action === 'checkPermissions') {
            checkClipboardPermission()
                .then(result => sendResponse(result))
                .catch(error => {
                    logger.error('Error checking permissions', error);
                    sendResponse({ success: false, error: error.message });
                });
            return true;
        } else if (request.action === 'getExtensionInfo') {
            sendResponse({
                success: true,
                version: chrome.runtime.getManifest().version,
                name: chrome.runtime.getManifest().name
            });
            return true;
        } else if (request.action === 'callN8nApi') {
            fetch(request.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request.payload)
            })
            .then(async (response) => {
                const rawText = await response.text();
                if (!response.ok) {
                    throw new Error(`API error: ${response.status} - ${rawText || response.statusText}`);
                }
                if (!rawText || !rawText.trim()) {
                    throw new Error('n8n workflow returned an empty response. Check your Respond to Webhook node in n8n.');
                }
                try {
                    return JSON.parse(rawText);
                } catch (e) {
                    return { comment: rawText.trim() };
                }
            })
            .then(data => sendResponse({ success: true, data }))
            .catch(error => {
                logger.error('n8n API call failed', error);
                sendResponse({ success: false, error: error.message });
            });
            return true;
        }
    } catch (error) {
        logger.error('Error handling message', error);
        sendResponse({ success: false, error: error.message });
    }

    return true;
});

async function checkClipboardPermission() {
    try {
        await navigator.clipboard.writeText("Test clipboard permission");
        return { success: true };
    } catch (error) {
        return {
            success: false,
            error: 'Clipboard access is required for copying comments.'
        };
    }
}

// Extension reload ya update hone par sabhi open LinkedIn tabs me naya content.js auto-inject karein
chrome.runtime.onInstalled.addListener(async () => {
    try {
        const tabs = await chrome.tabs.query({ url: 'https://*.linkedin.com/*' });
        for (const tab of tabs) {
            if (tab.id) {
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                }).catch(() => {});
            }
        }
    } catch (e) {
        logger.error('Failed to reinject content scripts', e);
    }
});