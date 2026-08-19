import { getTweet } from 'react-tweet/api';
import path from 'path';
import fs from 'fs';
import { Database, Asset } from './db.js';
import { performOCR, performVideoOCR } from './ocr.js';

// Regex to extract tweet ID from standard Twitter/X status URLs
const TWITTER_REGEX = /(?:twitter\.com|x\.com)\/[a-zA-Z0-9_]+\/status\/([0-9]+)/i;

export function extractTweetId(url: string): string | null {
  const match = url.match(TWITTER_REGEX);
  return match ? match[1] : null;
}

export interface TweetMedia {
  type: 'photo' | 'video' | 'animated_gif';
  url: string; // Direct image URL or video thumbnail image URL
  videoUrl?: string; // Direct MP4 video stream URL if type is video/gif
  durationMs?: number;
}

export interface TweetData {
  text: string;
  authorName: string;
  screenName: string;
  createdAt: string;
  media: TweetMedia[];
}

export async function fetchTweetContent(tweetId: string): Promise<TweetData | null> {
  try {
    const tweet = await getTweet(tweetId);
    
    if (!tweet) {
      console.error(`Tweet ID ${tweetId} returned null (deleted or private)`);
      return {
        text: '[This tweet is private, deleted, or unavailable.]',
        authorName: 'Unknown Author',
        screenName: 'unknown',
        createdAt: new Date().toISOString(),
        media: []
      };
    }

    const media: TweetMedia[] = tweet.mediaDetails?.map((m: any) => {
      const item: TweetMedia = {
        type: m.type,
        url: m.media_url_https
      };
      
      if (m.type === 'video' || m.type === 'animated_gif') {
        // Extract the highest resolution MP4 stream
        const mp4Variants = m.video_info?.variants?.filter((v: any) => v.content_type === 'video/mp4') || [];
        if (mp4Variants.length > 0) {
          mp4Variants.sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
          item.videoUrl = mp4Variants[0].url;
        }
        item.durationMs = m.video_info?.duration_millis;
      }
      
      return item;
    }) || [];

    return {
      text: tweet.text || '',
      authorName: tweet.user?.name || 'Unknown Author',
      screenName: tweet.user?.screen_name || 'unknown',
      createdAt: tweet.created_at || new Date().toISOString(),
      media
    };
  } catch (error: any) {
    console.error(`Failed to fetch Twitter post ${tweetId}:`, error.message);
    return null;
  }
}

export async function processTwitterLink(db: Database, url: string): Promise<boolean> {
  const tweetId = extractTweetId(url);
  if (!tweetId) return false;

  console.error(`Twitter/X link detected: ${url}`);
  const data = await fetchTweetContent(tweetId);

  if (data) {
    const id = `twitter-${tweetId}-${Date.now()}`;
    const cleanUrl = `https://x.com/${data.screenName}/status/${tweetId}`;
    
    let ocrTextCombined = '';
    const localMediaPaths: string[] = [];

    // Download media elements (images / video thumbnails) and run OCR
    if (data.media.length > 0) {
      const mediaDir = path.join(process.env.HOME || '', '.omnicontext', 'media');
      if (!fs.existsSync(mediaDir)) {
        fs.mkdirSync(mediaDir, { recursive: true });
      }

      for (let i = 0; i < data.media.length; i++) {
        const item = data.media[i];
        try {
          const imgRes = await fetch(item.url);
          if (imgRes.ok) {
            const buffer = Buffer.from(await imgRes.arrayBuffer());
            const ext = path.extname(new URL(item.url).pathname) || '.jpg';
            const localPath = path.join(mediaDir, `twitter-${tweetId}-${i}${ext}`);
            await fs.promises.writeFile(localPath, buffer);
            localMediaPaths.push(localPath);

            if (item.type === 'photo') {
              console.error(`Running local OCR on tweet image: ${localPath}`);
              const text = await performOCR(localPath);
              if (text) {
                ocrTextCombined += `\n[Attached Image ${i + 1} OCR Text]:\n${text}\n`;
              }
            } else {
              // It is a video or an animated gif
              console.error(`Running local OCR on tweet video thumbnail: ${localPath}`);
              const text = await performOCR(localPath);
              const durationSec = item.durationMs ? Math.round(item.durationMs / 1000) : 0;
              const durationStr = durationSec ? ` (${durationSec}s)` : '';
              
              ocrTextCombined += `\n[Attached Video ${i + 1}${durationStr}]:\n`;
              if (item.videoUrl) {
                ocrTextCombined += `Direct MP4 Link: ${item.videoUrl}\n`;
                
                // Fetch and download the raw MP4 video file to run frame-by-frame video OCR
                try {
                  const localVideoPath = path.join(mediaDir, `twitter-${tweetId}-${i}-video.mp4`);
                  console.error(`Downloading video stream to: ${localVideoPath}`);
                  const vidRes = await fetch(item.videoUrl);
                  if (vidRes.ok) {
                    const vidBuffer = Buffer.from(await vidRes.arrayBuffer());
                    await fs.promises.writeFile(localVideoPath, vidBuffer);
                    localMediaPaths.push(localVideoPath);
                    
                    console.error(`Running local frame-by-frame video OCR on: ${localVideoPath}`);
                    const videoText = await performVideoOCR(localVideoPath, 5); // check every 5 seconds
                    if (videoText) {
                      ocrTextCombined += `[Video Content OCR Text]:\n${videoText}\n`;
                    }
                  }
                } catch (vidErr: any) {
                  console.error(`Failed to perform video OCR for ${item.videoUrl}:`, vidErr.message);
                }
              }
              if (text) {
                ocrTextCombined += `[Thumbnail Image OCR Text]:\n${text}\n`;
              }
            }
          }
        } catch (e: any) {
          console.error(`Failed to process tweet media ${item.url}:`, e.message);
        }
      }
    }

    const ocrAppendix = ocrTextCombined ? `\n\n${ocrTextCombined.trim()}` : '';

    const asset: Asset = {
      id,
      type: 'download', // categorize under links / downloads context
      content: `Tweet by ${data.authorName} (@${data.screenName})\nDate: ${data.createdAt}\nURL: ${cleanUrl}\n\nContent:\n${data.text}${ocrAppendix}`,
      metadata: {
        title: `Tweet from @${data.screenName}`,
        createdAt: new Date().toISOString(),
        sourceUrl: cleanUrl,
        ...(localMediaPaths.length > 0 && { localMediaPaths })
      }
    };
    db.addAsset(asset);
    console.error(`Indexed tweet from @${data.screenName} (${data.text.length} chars, ${localMediaPaths.length} media items)`);
    return true;
  }

  return false;
}
