const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_YOUTUBE_CONFIG_DIR = path.join(PROJECT_ROOT, 'config', 'youtube');

class YouTubeUploader {
    constructor(tokenFileName = 'youtube-token.json', options = {}) {
        const configDir = (options && typeof options.configDir === 'string' && options.configDir.trim())
            ? options.configDir.trim()
            : DEFAULT_YOUTUBE_CONFIG_DIR;

        // 認証情報/トークンは config/local/youtube/（作業ディレクトリ側）に集約
        this.setConfigDir(configDir);
        this.setTokenFileName(tokenFileName);
    }

    setConfigDir(configDir) {
        if (!configDir || typeof configDir !== 'string') return this.configDir;
        const normalized = configDir.trim();
        if (!normalized) return this.configDir;

        this.configDir = normalized;
        this.CREDENTIALS_PATH = path.join(normalized, 'credentials.json');

        // 既存の tokenFileName がある場合は TOKEN_PATH を再計算
        if (this.tokenFileName) {
            this.setTokenFileName(this.tokenFileName);
        }
        return this.configDir;
    }

    _loadCredentials() {
        const raw = fs.readFileSync(this.CREDENTIALS_PATH, 'utf-8');
        const credentials = JSON.parse(raw);
        const client = credentials.installed || credentials.web;
        if (!client) {
            throw new Error('YouTube認証情報の形式が不正です');
        }
        return { credentials, client };
    }

    getDefaultRedirectUri() {
        const { client } = this._loadCredentials();
        const redirectUri = Array.isArray(client.redirect_uris) ? client.redirect_uris[0] : '';
        if (!redirectUri) {
            throw new Error('redirect_uris が設定されていません');
        }
        return redirectUri;
    }

    setTokenFileName(tokenFileName = 'youtube-token.json') {
        if (!tokenFileName || typeof tokenFileName !== 'string') {
            tokenFileName = 'youtube-token.json';
        }

        if (path.isAbsolute(tokenFileName)) {
            this.TOKEN_PATH = tokenFileName;
            this.tokenFileName = path.basename(tokenFileName);
        } else {
            const baseDir = this.configDir || DEFAULT_YOUTUBE_CONFIG_DIR;
            this.TOKEN_PATH = path.join(baseDir, tokenFileName);
            this.tokenFileName = tokenFileName;
        }
    }

    async authenticate() {
        try {
            const { client } = this._loadCredentials();
            const { client_secret, client_id, redirect_uris } = client;
            const redirectUri = Array.isArray(redirect_uris) ? redirect_uris[0] : '';
            if (!redirectUri) {
                throw new Error('redirect_uris が設定されていません');
            }
            const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirectUri);

            try {
                const token = JSON.parse(fs.readFileSync(this.TOKEN_PATH));
                
                // トークンの有効期限をチェック
                const expiryDate = token.expiry_date;
                // 期限切れの場合のみtrueになるように修正
                const isExpired = expiryDate ? Date.now() >= expiryDate : false;
                
                if (isExpired && token.refresh_token) {
                    // リフレッシュトークンがある場合は、トークンを更新
                    console.log('Token has expired, refreshing using refresh_token');
                    oAuth2Client.setCredentials({
                        refresh_token: token.refresh_token
                    });
                    
                    try {
                        // トークンを更新
                        const { credentials } = await oAuth2Client.refreshAccessToken();
                        oAuth2Client.setCredentials(credentials);
                        
                        // 更新されたトークンを保存
                        fs.mkdirSync(path.dirname(this.TOKEN_PATH), { recursive: true });
                        fs.writeFileSync(this.TOKEN_PATH, JSON.stringify(credentials));
                        console.log('Token has been refreshed and saved');
                        
                        return oAuth2Client;
                    } catch (refreshError) {
                        console.error('Error refreshing token:', refreshError);
                        // リフレッシュに失敗した場合は新規認証を実行
                        return await this.getNewToken(oAuth2Client);
                    }
                } else if (isExpired) {
                    // リフレッシュトークンがない場合は新規認証を実行
                    console.log('Token has expired and no refresh_token, getting a new one');
                    return await this.getNewToken(oAuth2Client);
                }
                
                oAuth2Client.setCredentials(token);
                return oAuth2Client;
            } catch (error) {
                // トークンファイルが存在しない場合は新規認証を実行
                return await this.getNewToken(oAuth2Client);
            }
        } catch (error) {
            console.error('Error loading YouTube credentials:', error);
            throw new Error('YouTube認証情報の読み込みに失敗しました');
        }
    }

    async getNewToken(oAuth2Client) {
        // 認証が必要なことを示すエラーをスロー
        throw new Error('YouTube認証が必要です');
    }

    async uploadVideo(options, progressCallback) {
        try {
            const auth = await this.authenticate();
            const youtube = google.youtube({ version: 'v3', auth });

            const { videoPath, title, description, tags, categoryId, thumbnailPath } = options;

            // アップロードリクエストの設定
            const requestBody = {
                snippet: {
                    title,
                    description,
                    tags: tags.split(',').map(tag => tag.trim()),
                    categoryId,
                    defaultLanguage: 'ja',
                    defaultAudioLanguage: 'ja'
                },
                status: {
                    privacyStatus: 'unlisted',
                    selfDeclaredMadeForKids: false,     // 子供向けコンテンツではない
                    containsSyntheticMedia: false        // 合成メディアを含む
                }
            };


            // ファイルストリームの作成と進捗イベントの設定
            const fileStream = fs.createReadStream(videoPath);
            const fileSize = fs.statSync(videoPath).size;
            let uploadedBytes = 0;
            let lastLoggedProgress = 0;
            
            fileStream.on('data', (chunk) => {
                uploadedBytes += chunk.length;
                const progress = (uploadedBytes / fileSize) * 100;
                
                // 1%以上の変化があった場合のみログを出力
                if (progress - lastLoggedProgress >= 1) {
                    console.log(`Upload progress: ${progress.toFixed(2)}%`);
                    progressCallback(progress / 100);
                    lastLoggedProgress = progress;
                }
            });

            // 動画ファイルのアップロード
            const response = await youtube.videos.insert({
                part: 'snippet,status',
                requestBody,
                media: {
                    body: fileStream
                }
            });

            // アップロード完了時に100%の進捗を通知
            progressCallback(1);

            const videoId = response.data.id;

            console.log('options:', options);
            console.log('thumbnailPath:', thumbnailPath);

            // サムネイルが指定されている場合は設定
            if (thumbnailPath && fs.existsSync(thumbnailPath)) {
                try {
                    console.log('Setting thumbnail for video:', videoId);
                    const thumbnailStream = fs.createReadStream(thumbnailPath);
                    
                    await youtube.thumbnails.set({
                        videoId: videoId,
                        media: {
                            body: thumbnailStream
                        }
                    });
                    
                    console.log('Thumbnail has been set successfully');
                } catch (thumbnailError) {
                    console.error('Error setting thumbnail:', thumbnailError);
                    // サムネイル設定の失敗は動画アップロード全体の失敗とはしない
                }
            }

            return {
                success: true,
                videoId: videoId
            };

        } catch (error) {
            console.error('YouTube upload error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    // 認証URLを取得するメソッド
    getAuthUrl(options = {}) {
        try {
            const { redirectUri, state } = options;
            const { client } = this._loadCredentials();
            const { client_secret, client_id, redirect_uris } = client;
            const fallbackRedirectUri = Array.isArray(redirect_uris) ? redirect_uris[0] : '';
            const effectiveRedirectUri = redirectUri || fallbackRedirectUri;
            if (!effectiveRedirectUri) {
                throw new Error('redirect_uris が設定されていません');
            }
            const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, effectiveRedirectUri);

            const SCOPES = ['https://www.googleapis.com/auth/youtube.upload'];
            const authParams = {
                access_type: 'offline',
                scope: SCOPES,
            };
            if (state) {
                authParams.state = state;
            }
            const authUrl = oAuth2Client.generateAuthUrl(authParams);

            return { authUrl, oAuth2Client, redirectUri: effectiveRedirectUri };
        } catch (error) {
            console.error('Error generating auth URL:', error);
            throw new Error('認証URL生成に失敗しました');
        }
    }

    // 認証コードを処理するメソッド
    async processAuthCode(code, oAuth2Client) {
        try {
            const { tokens } = await oAuth2Client.getToken(code);
            oAuth2Client.setCredentials(tokens);

            // トークンを保存
            fs.mkdirSync(path.dirname(this.TOKEN_PATH), { recursive: true });
            fs.writeFileSync(this.TOKEN_PATH, JSON.stringify(tokens));
            console.log('トークンを保存しました:', this.TOKEN_PATH);

            return oAuth2Client;
        } catch (error) {
            console.error('Error processing auth code:', error);
            throw new Error('認証コードの処理に失敗しました');
        }
    }

}

module.exports = YouTubeUploader; 
