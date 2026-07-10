import { Database, Asset } from './db.js';

// Regex to extract 11-character YouTube video ID
const YT_REGEX = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([^"&?\/\s]{11})/i;

export function extractVideoId(url: string): string | null {
  const match = url.match(YT_REGEX);
  return match ? match[1] : null;
}

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=')
    .replace(/&nbsp;/g, ' ');
}

export interface YoutubeData {
  title: string;
  channel: string;
  transcript: string;
}

export async function fetchYoutubeTranscript(videoId: string): Promise<YoutubeData | null> {
  const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
  const INNERTUBE_CLIENT_VERSION = '20.10.38';
  const INNERTUBE_CONTEXT = {
    client: {
      clientName: 'ANDROID',
      clientVersion: INNERTUBE_CLIENT_VERSION,
    },
  };
  const INNERTUBE_USER_AGENT = 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)';
  const TIMEDTEXT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';

  try {
    // 1. Fetch player response JSON via InnerTube API (avoids regional/bot blocks)
    const response = await fetch(INNERTUBE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': INNERTUBE_USER_AGENT,
      },
      body: JSON.stringify({
        context: INNERTUBE_CONTEXT,
        videoId: videoId
      })
    });

    if (!response.ok) {
      throw new Error(`InnerTube HTTP error ${response.status}`);
    }

    const data = (await response.json()) as any;

    // 2. Extract Metadata
    const title = decodeHtmlEntities(data.videoDetails?.title || 'Unknown YouTube Video');
    const channel = decodeHtmlEntities(data.videoDetails?.author || 'Unknown Channel');

    // 3. Extract Captions
    const captionTracks = data.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) {
      return {
        title,
        channel,
        transcript: '[No captions/subtitles available for this video.]'
      };
    }

    // Prefer English translation track, otherwise take the first available
    let selectedTrack = captionTracks.find((track: any) => 
      track.languageCode === 'en' || 
      track.languageCode?.startsWith('en-')
    );
    if (!selectedTrack) {
      selectedTrack = captionTracks[0];
    }

    const captionsUrl = selectedTrack.baseUrl;
    if (!captionsUrl) {
      return { title, channel, transcript: '[Caption track URL missing.]' };
    }

    // 4. Fetch XML subtitles using the special browser player User-Agent (otherwise returns empty)
    const xmlResponse = await fetch(captionsUrl, {
      headers: {
        'User-Agent': TIMEDTEXT_USER_AGENT
      }
    });

    if (!xmlResponse.ok) {
      throw new Error(`Failed to fetch timedtext XML: ${xmlResponse.status}`);
    }

    const xml = await xmlResponse.text();

    // 5. Parse transcript (supports timedtext format="3" and classic format)
    let transcript = '';
    
    // Check if it is format="3" (contains <s> tags)
    if (xml.includes('</timedtext>') || xml.includes('</s>')) {
      // Strip XML tags, leaving words separated by spaces
      transcript = xml
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    } else {
      // Classic format (contains <text> tags)
      const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/gi;
      const textMatches: string[] = [];
      let match;
      while ((match = textRegex.exec(xml)) !== null) {
        if (match[1]) {
          textMatches.push(match[1]);
        }
      }
      transcript = textMatches.join(' ').replace(/\s+/g, ' ').trim();
    }

    transcript = decodeHtmlEntities(transcript);

    if (!transcript) {
      return { title, channel, transcript: '[Captions parsed, but no text was found.]' };
    }

    return {
      title,
      channel,
      transcript
    };
  } catch (error: any) {
    console.error(`Failed to fetch transcript for YouTube video ${videoId}:`, error.message);
    return null;
  }
}

export async function processYoutubeLink(db: Database, url: string): Promise<boolean> {
  const videoId = extractVideoId(url);
  if (!videoId) return false;

  console.error(`YouTube link detected: ${url}`);
  const data = await fetchYoutubeTranscript(videoId);

  if (data) {
    // Prevent overwriting a valid transcript with a warning/error message due to rate-limiting
    const existing = db.getRecent(100, 'download').find(a => a.metadata.sourceUrl?.includes(videoId));
    if (existing && existing.content.includes('Transcript:\n') && !existing.content.includes('Transcript:\n[')) {
      if (data.transcript.startsWith('[') && data.transcript.endsWith(']')) {
        console.error(`Valid transcript already exists for ${videoId}. Skipping overwrite with rate-limit warning.`);
        return true;
      }
    }

    const id = `youtube-${videoId}-${Date.now()}`;
    const asset: Asset = {
      id,
      type: 'download', // categorize under download / links context
      content: `YouTube Video: ${data.title}\nChannel: ${data.channel}\nURL: https://youtube.com/watch?v=${videoId}\n\nTranscript:\n${data.transcript}`,
      metadata: {
        title: data.title,
        createdAt: new Date().toISOString(),
        sourceUrl: `https://youtube.com/watch?v=${videoId}`
      }
    };
    db.addAsset(asset);
    console.error(`Indexed YouTube video: ${data.title} (${data.transcript.length} chars)`);
    return true;
  }

  return false;
}
