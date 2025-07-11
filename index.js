const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid'); // For unique ID generation
const fs = require('fs').promises; // For async file system operations
const path = require('path');
const os = require('os'); // For temporary directory
const crypto = require('crypto'); // For random PIN generation

// --- Bot Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN; // Reads from Vercel Environment Variables
const SEND_MESSAGE_API_URL = "https://typical-gracia-pdbot-aed22ab6.koyeb.app/send-message";

const bot = new TelegramBot(BOT_TOKEN);

// --- Logger (simple console logs for serverless functions) ---
const logger = {
    info: (...args) => console.log('INFO:', ...args),
    warn: (...args) => console.warn('WARN:', ...args),
    error: (...args) => console.error('ERROR:', ...args),
};

// --- Firebase Initialization ---
let db;
let bucket; // For Firebase Storage, though not fully implemented in Python code

const firebaseServiceAccountKeyJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

if (firebaseServiceAccountKeyJson) {
    try {
        const serviceAccount = JSON.parse(firebaseServiceAccountKeyJson);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            // Add storageBucket if you plan to use Firebase Storage
            // storageBucket: 'your-firebase-project-id.appspot.com' // e.g., filesharebot-69436.appspot.com
        });
        db = admin.firestore();
        // bucket = admin.storage().bucket(); // Initialize storage bucket if needed
        logger.info("Firebase initialized successfully.");
    } catch (e) {
        logger.error(`Failed to initialize Firebase: ${e.message}`);
        db = null;
    }
} else {
    logger.error("FIREBASE_SERVICE_ACCOUNT_KEY not found in Environment Variables. Firebase will not be initialized.");
    db = null;
}

// --- Gemini AI Initialization ---
let geminiModel;
const geminiApiKey = process.env.GEMINI_API_KEY; // Reads from Vercel Environment Variables

if (geminiApiKey) {
    try {
        const genAI = new GoogleGenerativeAI(geminiApiKey);
        geminiModel = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
        logger.info("Gemini AI model initialized successfully.");
    } catch (e) {
        logger.error(`Failed to initialize Gemini AI: ${e.message}`);
        geminiModel = null;
    }
} else {
    logger.error("GEMINI_API_KEY not found in Environment Variables. Gemini AI will not be initialized.");
    geminiModel = null;
}

// Firestore Collection Path (Public data for file metadata)
const APP_ID = "telegram_bot_app";
const FILES_COLLECTION_PATH = `artifacts/${APP_ID}/public/data/files`;
const FILES_COLLECTION = db ? db.collection(FILES_COLLECTION_PATH) : null;

// --- Conversation States (Manual Management) ---
// Using a Map to store user states for multi-step conversations
// WARNING: This is an in-memory map. State will be lost if the Vercel function
// spins down and up. For persistent state, consider a database like Redis.
const userStates = new Map();

const STATES = {
    NONE: 'none',
    SENDMSG_ASK_NUMBER: 'sendmsg_ask_number',
    SENDMSG_ASK_MESSAGE: 'sendmsg_ask_message',
    YT_ASK_URL: 'yt_ask_url', // This functionality will be noted as unavailable
    UPLOAD_WAIT_FILE: 'upload_wait_file',
    GETFILE_ASK_PIN: 'getfile_ask_pin',
    AI_ASK_QUERY: 'ai_ask_query',
    DOWNLOAD_ASK_URL: 'download_ask_url',
};

// --- Helper Functions ---
function generatePin(length = 6) {
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

async function isPinUnique(pin) {
    if (!FILES_COLLECTION) {
        logger.error("Firestore not initialized, cannot check PIN uniqueness.");
        return false;
    }
    try {
        const doc = await FILES_COLLECTION.doc(pin).get();
        return !doc.exists;
    } catch (e) {
        logger.error(`Error checking PIN uniqueness: ${e.message}`);
        return false; // Assume not unique on error to prevent duplicates
    }
}

async function generateUniquePin(length = 6) {
    while (true) {
        const pin = generatePin(length);
        if (await isPinUnique(pin)) {
            return pin;
        }
        await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
    }
}

// --- Send Message API Function ---
async function sendMessageViaApi(number, messageText) {
    logger.info(`Attempting to send message to number: ${number} with text: ${messageText.substring(0, 50)}...`);
    const payload = { number, message: messageText };
    const headers = { "Content-Type": "application/json" };

    try {
        const response = await fetch(SEND_MESSAGE_API_URL, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(payload),
            timeout: 20000 // 20 seconds timeout
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
        }

        const apiResponse = await response.json();

        if (apiResponse.status === "success") {
            logger.info(`Message sent successfully to ${number}. API Response: ${JSON.stringify(apiResponse)}`);
            return true;
        } else {
            logger.warn(`Failed to send message to ${number}. API Response: ${JSON.stringify(apiResponse)}`);
            return false;
        }
    } catch (e) {
        logger.error(`Message API call failed for number ${number}: ${e.message}. URL: ${SEND_MESSAGE_API_URL}`);
        return false;
    }
}

// --- AI API Function ---
async function askGeminiAi(query) {
    if (!geminiModel) {
        return "AI සේවාව ලබා ගත නොහැක. කරුණාකර පසුව උත්සාහ කරන්න.";
    }

    logger.info(`Asking AI: ${query.substring(0, 100)}...`);
    try {
        const result = await geminiModel.generateContent(query);
        const response = await result.response;
        return response.text();
    } catch (e) {
        logger.error(`Error calling Gemini AI: ${e.message}`);
        return "AI ප්‍රතිචාරයක් ලබාගැනීමේ දෝෂයක් සිදුවිය. කරුණාකර පසුව උත්සාහ කරන්න.";
    }
}

// --- External URL Download Function ---
async function downloadFileFromUrl(url, chatId) {
    await bot.sendMessage(chatId, 'File එක download කරමින් සිටී. කරුණාකර මොහොතක් රැඳී සිටින්න...');
    logger.info(`Attempting to download file from URL: ${url}`);

    let tempDir;
    try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'download-'));

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        // Get filename from headers or URL
        let filename = 'downloaded_file';
        const contentDisposition = response.headers.get('Content-Disposition');
        if (contentDisposition) {
            const match = /filename="([^"]+)"/.exec(contentDisposition);
            if (match && match[1]) {
                filename = match[1];
            }
        }
        if (filename === 'downloaded_file') { // Fallback if not found in headers
            filename = path.basename(new URL(url).pathname);
            if (!filename || filename === '/') filename = 'downloaded_file';
        }

        const filePath = path.join(tempDir, filename);
        const fileStream = fs.createWriteStream(filePath);
        await new Promise((resolve, reject) => {
            response.body.pipe(fileStream);
            response.body.on('error', reject);
            fileStream.on('finish', resolve);
        });

        const stats = await fs.stat(filePath);
        const fileSize = stats.size;
        logger.info(`Downloaded file: ${filePath}, Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);

        // Telegram Bot API has a 50MB limit for direct file uploads
        const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
        if (fileSize > TELEGRAM_FILE_LIMIT) {
            await bot.sendMessage(
                chatId,
                `File එක (${(fileSize / (1024 * 1024)).toFixed(2)} MB) Telegram හරහා කෙලින්ම යැවීමට විශාල වැඩියි. කරුණාකර වෙනත් download ක්‍රමයක් භාවිතා කරන්න.`
            );
            logger.warn(`File too large for direct Telegram upload: ${url} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)`);
            return;
        }

        await bot.sendMessage(chatId, 'File එක යවමින් සිටී...');
        await bot.sendDocument(chatId, filePath, { caption: `ඔබගේ file එක: ${filename}` });
        await bot.sendMessage(chatId, '✅ **File එක සාර්ථකව යවන ලදී!**');

    } catch (e) {
        logger.error(`Error downloading file from URL ${url}: ${e.message}`);
        await bot.sendMessage(
            chatId,
            `❌ File එක download කිරීමේ දෝෂයක් සිදුවිය: ${e.message}. කරුණාකර URL එක නිවැරදිදැයි පරීක්ෂා කරන්න.`
        );
    } finally {
        if (tempDir) {
            await fs.rm(tempDir, { recursive: true, force: true });
            logger.info(`Cleaned up temporary directory: ${tempDir}`);
        }
    }
}

// --- Bot Commands and State Handlers ---

// Main handler for all messages
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const document = msg.document;
    const photo = msg.photo;
    const video = msg.video;
    const audio = msg.audio;

    const currentState = userStates.get(chatId) || STATES.NONE;

    logger.info(`Received message from ${chatId}. Current state: ${currentState}. Text: ${text || '[No Text]'}`);

    // --- Conversation Handlers ---
    if (currentState === STATES.SENDMSG_ASK_NUMBER) {
        if (text && !text.startsWith('/')) {
            const numberInput = text;
            if (!/^\d{10,}$/.test(numberInput)) { // Basic validation for 10+ digits
                await bot.sendMessage(chatId, 'කරුණාකර වලංගු දුරකථන අංකයක් ඇතුළත් කරන්න. (උදා: 94712345678)');
                return; // Stay in the same state
            }
            userStates.set(chatId, STATES.SENDMSG_ASK_MESSAGE);
            userStates.set(chatId + '_number', numberInput); // Store number
            logger.info(`Received number for message: ${numberInput}`);
            await bot.sendMessage(chatId, 'හොඳයි. දැන් කරුණාකර ඔබට යැවීමට අවශ්‍ය **message එක** ඇතුළත් කරන්න.');
        } else {
            await bot.sendMessage(chatId, 'කරුණාකර වලංගු දුරකථන අංකයක් ඇතුළත් කරන්න.');
        }
    } else if (currentState === STATES.SENDMSG_ASK_MESSAGE) {
        if (text && !text.startsWith('/')) {
            const messageTextInput = text;
            const number = userStates.get(chatId + '_number');

            if (number && messageTextInput) {
                await bot.sendMessage(chatId, 'ඔබගේ message එක යවමින් සිටී...');
                const isSent = await sendMessageViaApi(number, messageTextInput);

                if (isSent) {
                    await bot.sendMessage(chatId, '✅ **Message සාර්ථකව යවන ලදී!**');
                } else {
                    await bot.sendMessage(chatId, '❌ **Message යැවීම අසාර්ථක විය.** කරුණාකර නැවත උත්සාහ කරන්න.');
                }
            } else {
                await bot.sendMessage(chatId, 'අංකය හෝ message එක ලබාගැනීමේ දෝෂයක් සිදුවිය. කරුණාකර නැවත /sendmsg කරන්න.');
            }
            userStates.delete(chatId); // End conversation
            userStates.delete(chatId + '_number');
        } else {
            await bot.sendMessage(chatId, 'කරුණාකර ඔබට යැවීමට අවශ්‍ය message එක ඇතුළත් කරන්න.');
        }
    } else if (currentState === STATES.YT_ASK_URL) {
        // YT_DLp is not supported in JS directly.
        await bot.sendMessage(chatId, '❌ YouTube download සේවාව දැනට ලබා ගත නොහැක. (මෙම විශේෂාංගය Python-විශේෂිතයි)');
        userStates.delete(chatId); // End conversation
    } else if (currentState === STATES.DOWNLOAD_ASK_URL) {
        if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
            await downloadFileFromUrl(text, chatId);
            userStates.delete(chatId); // End conversation
        } else {
            await bot.sendMessage(chatId, 'කරුණාකර වලංගු URL එකක් ඇතුළත් කරන්න (http:// හෝ https:// වලින් ආරම්භ විය යුතුය).');
        }
    } else if (currentState === STATES.UPLOAD_WAIT_FILE) {
        let fileObj = null;
        let fileType = "document";
        let fileName = "uploaded_file";

        if (document) {
            fileObj = document;
            fileName = document.file_name || fileName;
        } else if (video) {
            fileObj = video;
            fileType = "video";
            fileName = video.file_name || fileName;
        } else if (audio) {
            fileObj = audio;
            fileType = "audio";
            fileName = audio.file_name || fileName;
        } else if (photo) {
            fileObj = photo[photo.length - 1]; // Get largest photo
            fileType = "photo";
            fileName = `photo_${fileObj.file_unique_id}.jpg`; // Generate unique name
        }

        if (!fileObj) {
            await bot.sendMessage(chatId, 'කරුණාකර වලංගු file එකක් (document, video, audio, photo) එවන්න.');
            return; // Stay in the same state
        }

        const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024; // 50 MB
        if (fileObj.file_size && fileObj.file_size > TELEGRAM_FILE_LIMIT) {
            await bot.sendMessage(
                chatId,
                `ඔබගේ file එක (${(fileObj.file_size / (1024 * 1024)).toFixed(2)} MB) Telegram හරහා කෙලින්ම ගබඩා කිරීමට සහ යැවීමට විශාල වැඩියි. 50MB ට අඩු files පමණක් upload කරන්න.`
            );
            userStates.delete(chatId); // End conversation for large files
            return;
        }

        if (!FILES_COLLECTION) {
            await bot.sendMessage(chatId, "File upload සේවාව ලබා ගත නොහැක. කරුණාකර පසුව උත්සාහ කරන්න.");
            userStates.delete(chatId);
            return;
        }

        await bot.sendMessage(chatId, 'File එක ගබඩා කරමින් PIN එකක් සාදමින් සිටී...');
        logger.info(`Received file for upload: ${fileObj.file_id}, size: ${fileObj.file_size}`);

        try {
            const uniquePin = await generateUniquePin();

            const fileMetadata = {
                file_id: fileObj.file_id,
                file_name: fileName,
                mime_type: fileObj.mime_type || 'application/octet-stream',
                file_size: fileObj.file_size,
                pin: uniquePin,
                uploaded_by: msg.from.id,
                upload_timestamp: admin.firestore.FieldValue.serverTimestamp()
            };

            await FILES_COLLECTION.doc(uniquePin).set(fileMetadata);

            await bot.sendMessage(
                chatId,
                `✅ **File එක සාර්ථකව upload කරන ලදී!**\n` +
                `ඔබගේ PIN එක: \`${uniquePin}\`\n\n` +
                'මෙම PIN එක ඕනෑම කෙනෙකුට /get_file command එක භාවිතා කර ඔබගේ file එක download කිරීමට භාවිතා කළ හැක.'
            );
            logger.info(`File ${fileObj.file_id} uploaded with PIN: ${uniquePin}`);

        } catch (e) {
            logger.error(`Error processing uploaded file or saving to Firestore: ${e.message}`);
            await bot.sendMessage(chatId, '❌ File upload කිරීමේ දෝෂයක් සිදුවිය. කරුණාකර නැවත උත්සාහ කරන්න.');
        }
        userStates.delete(chatId); // End conversation
    } else if (currentState === STATES.GETFILE_ASK_PIN) {
        if (text && !text.startsWith('/')) {
            const pin = text.trim().toUpperCase();
            if (!FILES_COLLECTION) {
                await bot.sendMessage(chatId, "File download සේවාව ලබා ගත නොහැක. කරුණාකර පසුව උත්සාහ කරන්න.");
                userStates.delete(chatId);
                return;
            }

            await bot.sendMessage(chatId, `PIN එක \`${pin}\` සමඟ file එක සොයමින්...`);
            logger.info(`Attempting to retrieve file with PIN: ${pin}`);

            try {
                const doc = await FILES_COLLECTION.doc(pin).get();

                if (doc.exists) {
                    const fileMetadata = doc.data();
                    const telegramFileId = fileMetadata.file_id;
                    const fileName = fileMetadata.file_name || 'downloaded_file';
                    const fileSize = fileMetadata.file_size || 0;

                    if (!telegramFileId) {
                        await bot.sendMessage(chatId, 'ගැටලුවක් සිදුවිය: File ID එක සොයාගත නොහැක.');
                        logger.error(`File ID missing for PIN: ${pin}`);
                        userStates.delete(chatId);
                        return;
                    }

                    const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;
                    if (fileSize > TELEGRAM_FILE_LIMIT) {
                        await bot.sendMessage(
                            chatId,
                            `ඔබ සොයන file එක (${(fileSize / (1024 * 1024)).toFixed(2)} MB) Telegram හරහා කෙලින්ම යැවීමට විශාල වැඩියි. කරුණාකර වෙනත් download ක්‍රමයක් භාවිතා කරන්න.`
                        );
                        logger.warn(`File for PIN ${pin} too large for direct Telegram upload.`);
                        userStates.delete(chatId);
                        return;
                    }

                    await bot.sendMessage(chatId, 'File එක download කරමින් සිටී...');
                    logger.info(`Downloading file from Telegram with ID: ${telegramFileId}`);

                    try {
                        // getFileLink provides a direct URL for the file on Telegram's servers
                        // const fileLink = await bot.getFileLink(telegramFileId);
                        
                        // It's generally better to send files by file_id if they are already on Telegram's servers
                        // as it saves bandwidth and is faster.
                        await bot.sendDocument(
                            chatId,
                            telegramFileId, // Send by file_id directly
                            { filename: fileName, caption: `ඔබගේ file එක: ${fileName}` }
                        );
                        await bot.sendMessage(chatId, '✅ **File එක සාර්ථකව යවන ලදී!**');
                        logger.info(`File for PIN ${pin} sent successfully.`);

                    } catch (e) {
                        logger.error(`Telegram error when sending file ${telegramFileId} for PIN ${pin}: ${e.message}`);
                        await bot.sendMessage(
                            chatId,
                            '❌ Telegram හරහා file එක ලබාගැනීමේ දෝෂයක් සිදුවිය. (File ID වලංගු නොවිය හැක හෝ කල් ඉකුත් වී ඇත).'
                        );
                    }

                } else {
                    await bot.sendMessage(chatId, '❌ වලංගු PIN එකක් නොවේ. කරුණාකර නිවැරදි PIN එක ඇතුළත් කරන්න.');
                    logger.warn(`Invalid PIN entered: ${pin}`);
                }
            } catch (e) {
                logger.error(`Error retrieving file from Firestore for PIN ${pin}: ${e.message}`);
                await bot.sendMessage(chatId, '❌ File සොයාගැනීමේදී දෝෂයක් සිදුවිය. කරුණාකර පසුව උත්සාහ කරන්න.');
            }
            userStates.delete(chatId); // End conversation
        } else {
            await bot.sendMessage(chatId, 'කරුණාකර ඔබට download කිරීමට අවශ්‍ය file එකේ **PIN එක** ඇතුළත් කරන්න.');
        }
    } else if (currentState === STATES.AI_ASK_QUERY) {
        if (text && !text.startsWith('/')) {
            if (!geminiModel) {
                await bot.sendMessage(chatId, "AI සේවාව ලබා ගත නොහැක. කරුණාකර පසුව උත්සාහ කරන්න.");
                userStates.delete(chatId);
                return;
            }
            await bot.sendMessage(chatId, 'ඔබගේ ප්‍රශ්නයට AI ප්‍රතිචාරයක් සකස් කරමින් සිටී...');
            const aiResponse = await askGeminiAi(text);
            await bot.sendMessage(chatId, aiResponse);
            userStates.delete(chatId); // End conversation
        } else {
            await bot.sendMessage(chatId, 'AI සමඟ කතා කිරීමට ඔබට අවශ්‍ය ප්‍රශ්නය හෝ විමසුම ඇතුළත් කරන්න.');
        }
    }
    // --- End Conversation Handlers ---

    // --- Command Handlers (when no active conversation state) ---
    if (text && text.startsWith('/')) {
        const command = text.split(' ')[0];
        if (command === '/start') {
            logger.info(`[DEBUG] Attempting to send /start welcome message to ${chatId}`); // මෙතැනට අලුත් log එක
            try {
                await bot.sendMessage(
                    chatId,
                    'ආයුබෝවන්! මම ඔබට දුරකථන අංකයකට message යැවීමට, ' +
                    'ඕනෑම URL එකකින් files download කිරීමට, AI සමඟ කතා කිරීමට, ' +
                    'සහ files upload කර PIN එකකින් නැවත download කිරීමට උදව් කරන bot කෙනෙක්. \n\n' +
                    'Commands:\n' +
                    '/sendmsg - දුරකථන අංකයකට message එකක් යවන්න.\n' +
                    '/yt_download - YouTube video එකක් download කරන්න. (දැනට නොමැත)\n' +
                    '/download_url - ඕනෑම URL එකකින් file එකක් download කරන්න.\n' +
                    '/upload_file - File එකක් upload කර PIN එකක් ලබාගන්න.\n' +
                    '/get_file - PIN එකක් දී file එකක් download කරන්න.\n' +
                    '/ask_ai - AI සමඟ කතා කරන්න.\n' +
                    '/cancel - ඕනෑම ක්‍රියාවලියක් අවලංගු කරන්න.'
                );
                logger.info(`[DEBUG] Successfully initiated sending /start message to ${chatId}`); // මෙතැනට අලුත් log එක
            } catch (error) {
                logger.error(`[ERROR] Failed to send /start message to ${chatId}: ${error.message}`); // මෙතැනට අලුත් error log එක
            }
        } else if (command === '/sendmsg') {
            userStates.set(chatId, STATES.SENDMSG_ASK_NUMBER);
            await bot.sendMessage(chatId, 'කරුණාකර ඔබට message එක යැවීමට අවශ්‍ය **දුරකථන අංකය** ඇතුළත් කරන්න (රට කේතය සමඟ, උදා: 94712345678).');
        } else if (command === '/yt_download') {
            userStates.set(chatId, STATES.YT_ASK_URL);
            await bot.sendMessage(chatId, '❌ YouTube download සේවාව දැනට ලබා ගත නොහැක. (මෙම විශේෂාංගය Python-විශේෂිතයි)');
        } else if (command === '/download_url') {
            userStates.set(chatId, STATES.DOWNLOAD_ASK_URL);
            await bot.sendMessage(chatId, 'කරුණාකර ඔබට download කිරීමට අවශ්‍ය file එකේ **External URL එක** ඇතුළත් කරන්න.');
        } else if (command === '/upload_file') {
            if (!FILES_COLLECTION) {
                await bot.sendMessage(chatId, "File upload සේවාව ලබා ගත නොහැක. කරුණාකර පසුව උත්සාහ කරන්න.");
                return;
            }
            userStates.set(chatId, STATES.UPLOAD_WAIT_FILE);
            await bot.sendMessage(chatId, 'කරුණාකර ඔබට upload කිරීමට අවශ්‍ය **file එක** (photo, video, document, audio) එවන්න.');
        } else if (command === '/get_file') {
            if (!FILES_COLLECTION) {
                await bot.sendMessage(chatId, "File download සේවාව ලබා ගත නොහැක. කරුණාකර පසුව උත්සාහ කරන්න.");
                return;
            }
            userStates.set(chatId, STATES.GETFILE_ASK_PIN);
            await bot.sendMessage(chatId, 'කරුණාකර ඔබට download කිරීමට අවශ්‍ය file එකේ **PIN එක** ඇතුළත් කරන්න.');
        } else if (command === '/ask_ai') {
            if (!geminiModel) {
                await bot.sendMessage(chatId, "AI සේවාව ලබා ගත නොහැක. කරුණාකර පසුව උත්සාහ කරන්න.");
                return;
            }
            userStates.set(chatId, STATES.AI_ASK_QUERY);
            await bot.sendMessage(chatId, 'AI සමඟ කතා කිරීමට ඔබට අවශ්‍ය ප්‍රශ්නය හෝ විමසුම ඇතුළත් කරන්න.');
        } else if (command === '/cancel') {
            userStates.delete(chatId); // Clear user state
            userStates.delete(chatId + '_number'); // Clear any specific data
            await bot.sendMessage(chatId, 'ක්‍රියාවලිය අවලංගු කරන ලදී.');
        } else {
            // Unhandled command
            await bot.sendMessage(chatId, "මට තේරෙන්නේ නැහැ. කරුණාකර /start command එක භාවිතා කර ලබා ගත හැකි commands බලන්න.");
        }
    } else if (currentState === STATES.NONE) {
        // Handle unhandled non-command messages when no conversation is active
        if (msg.text) {
            logger.info(`Received unhandled message: ${msg.text}`);
            await bot.sendMessage(
                chatId,
                "මට තේරෙන්නේ නැහැ. කරුණාකර /start command එක භාවිතා කර ලබා ගත හැකි commands බලන්න."
            );
        } else if (document || photo || video || audio) {
            // If a file is sent directly without a command, prompt the user
            await bot.sendMessage(
                chatId,
                "ඔබ file එකක් එවා ඇත. එය upload කිරීමට /upload_file භාවිතා කරන්න, නැතහොත් වෙනත් commands සඳහා /start බලන්න."
            );
        } else {
            // Any other unhandled message type (sticker, voice, etc.)
            await bot.sendMessage(
                chatId,
                "මට තේරෙන්නේ නැහැ. කරුණාකර /start command එක භාවිතා කර ලබා ගත හැකි commands බලන්න."
            );
        }
    }
});


// --- Vercel Serverless Function Entry Point ---
// This is what Vercel executes when your bot receives a webhook update
module.exports = async (req, res) => {
    if (req.method === 'POST') {
        try {
            // Process the Telegram update
            await bot.processUpdate(req.body);
            res.status(200).send('OK');
        } catch (error) {
            logger.error('Error while processing update:', error);
            res.status(500).send('Error');
        }
    } else {
        // For GET requests, just send a simple message
        res.status(200).send('Telegram Bot Webhook is running.');
    }
};

logger.info("Bot webhook handler initialized.");
