import fs from 'fs';
import path from 'path';

export interface Asset {
  id: string;
  type: 'screenshot' | 'download' | 'note' | 'clipboard';
  filePath?: string;
  content: string;
  summary?: string;
  metadata: {
    title?: string;
    createdAt: string;
    sourceUrl?: string;
    colors?: string[];
    mimeType?: string;
    localMediaPaths?: string[];
  };
}

const DB_DIR = path.join(process.env.HOME || '', '.omnicontext');
const DB_FILE = path.join(DB_DIR, 'db.json');

export class Database {
  private assets: Asset[] = [];

  constructor() {
    this.init();
  }

  private init() {
    if (!fs.existsSync(DB_DIR)) {
      fs.mkdirSync(DB_DIR, { recursive: true });
    }
    this.reload();
  }

  public reload() {
    if (fs.existsSync(DB_FILE)) {
      try {
        const data = fs.readFileSync(DB_FILE, 'utf-8');
        this.assets = JSON.parse(data);
      } catch (e) {
        // If file is locked, empty, or parsing fails, keep memory state
      }
    } else {
      this.assets = [];
      this.save();
    }
  }

  public save() {
    const tempFile = DB_FILE + '.tmp';
    try {
      fs.writeFileSync(tempFile, JSON.stringify(this.assets, null, 2), 'utf-8');
      fs.renameSync(tempFile, DB_FILE);
    } catch (e) {
      console.error('Failed to write database atomically:', e);
    }
  }

  public addAsset(asset: Asset) {
    this.reload();
    // Check if asset already exists by filePath or ID to avoid duplicates
    if (asset.filePath) {
      this.assets = this.assets.filter(a => a.filePath !== asset.filePath);
    } else {
      this.assets = this.assets.filter(a => a.id !== asset.id);
    }
    this.assets.push(asset);
    this.save();
  }

  public touchAssetByUrl(url: string): boolean {
    this.reload();
    const asset = this.assets.find(a => a.type === 'download' && a.metadata.sourceUrl === url);
    if (asset) {
      asset.metadata.createdAt = new Date().toISOString();
      this.save();
      return true;
    }
    return false;
  }

  public getRecent(limit = 10, type?: string): Asset[] {
    this.reload();
    let filtered = [...this.assets];
    if (type && type !== 'all') {
      filtered = filtered.filter(a => a.type === type);
    }
    // Sort descending by date
    filtered.sort((a, b) => new Date(b.metadata.createdAt).getTime() - new Date(a.metadata.createdAt).getTime());
    return filtered.slice(0, limit);
  }

  public search(query: string, limit = 5, type?: string): { asset: Asset; score: number }[] {
    this.reload();
    let filtered = [...this.assets];
    if (type && type !== 'all') {
      filtered = filtered.filter(a => a.type === type);
    }

    if (filtered.length === 0) return [];

    // Filter out reflected query clipboard logs and assistant responses to avoid self-pollution
    const qClean = query.toLowerCase().replace(/[^\w\s]/g, '').trim();
    filtered = filtered.filter(a => {
      if (a.type === 'clipboard') {
        const contentLower = a.content.toLowerCase();
        // Exclude system/assistant transcripts and user query logs
        if (contentLower.includes("error talking to") || 
            contentLower.includes("talked to") ||
            contentLower.includes("i tried") ||
            contentLower.includes("show me") ||
            contentLower.includes("any link") ||
            contentLower.includes("related to")) {
          return false;
        }
        const cClean = contentLower.replace(/[^\w\s]/g, '').trim();
        if (cClean === qClean || (qClean.length > 2 && cClean.includes(qClean) && cClean.length < qClean.length + 20)) {
          return false;
        }
      }
      return true;
    });

    if (filtered.length === 0) return [];

    // Simple TF-IDF Vector Space Model for Local Semantic Search
    const stopWords = new Set([
      'i', 'me', 'my', 'myself', 'we', 'our', 'ours', 'ourselves', 'you', 'your', 'yours', 
      'he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 
      'they', 'them', 'their', 'theirs', 'themselves', 'the', 'a', 'an', 'and', 'but', 'if', 
      'or', 'because', 'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 
      'against', 'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below', 
      'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again', 'further', 
      'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 
      'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 
      'own', 'same', 'so', 'than', 'too', 'very', 's', 't', 'can', 'will', 'just', 'don', 
      'should', 'now', 'was', 'were', 'is', 'am', 'are', 'be', 'been', 'being', 'have', 
      'has', 'had', 'do', 'does', 'did', 'would', 'could', 'should'
    ]);
    
    const tokenize = (text: string): string[] => {
      return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 1 && !stopWords.has(word));
    };

    // Calculate document frequencies
    const docTokens = filtered.map(asset => tokenize(asset.content + ' ' + (asset.metadata.title || '') + ' ' + (asset.summary || '')));
    const allTokens = new Set<string>();
    docTokens.forEach(tokens => tokens.forEach(t => allTokens.add(t)));
    
    const df: Record<string, number> = {};
    docTokens.forEach(tokens => {
      const uniqueInDoc = new Set(tokens);
      uniqueInDoc.forEach(t => {
        df[t] = (df[t] || 0) + 1;
      });
    });

    // Calculate TF-IDF vectors
    const N = filtered.length;
    const idf: Record<string, number> = {};
    allTokens.forEach(t => {
      idf[t] = Math.log(1 + N / (df[t] || 1));
    });

    const getVector = (tokens: string[]): Record<string, number> => {
      const tf: Record<string, number> = {};
      tokens.forEach(t => {
        tf[t] = (tf[t] || 0) + 1;
      });
      
      const vec: Record<string, number> = {};
      Object.keys(tf).forEach(t => {
        if (idf[t]) {
          vec[t] = tf[t] * idf[t];
        }
      });
      return vec;
    };

    const docVectors = docTokens.map(tokens => getVector(tokens));
    const queryTokens = tokenize(query);
    const queryVector = getVector(queryTokens);

    const cosineSimilarity = (v1: Record<string, number>, v2: Record<string, number>): number => {
      let dotProduct = 0;
      let mag1 = 0;
      let mag2 = 0;

      // Since vectors are sparse, we only iterate keys
      Object.keys(v1).forEach(k => {
        mag1 += v1[k] * v1[k];
        if (v2[k]) {
          dotProduct += v1[k] * v2[k];
        }
      });

      Object.keys(v2).forEach(k => {
        mag2 += v2[k] * v2[k];
      });

      if (mag1 === 0 || mag2 === 0) return 0;
      return dotProduct / (Math.sqrt(mag1) * Math.sqrt(mag2));
    };

    const results = filtered.map((asset, index) => {
      let baseScore = cosineSimilarity(queryVector, docVectors[index]);
      let score = baseScore;

      // 1. Recency Boost (Exponential Decay: half-life of ~8 hours, max +0.8 boost for brand new copies)
      const ageInDays = (Date.now() - new Date(asset.metadata.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBoost = 0.8 * Math.exp(-ageInDays * 2.0);
      
      // 2. Keyword exact match and stemming/fuzzy boost on Title/Metadata
      const titleLower = (asset.metadata.title || '').toLowerCase();
      const contentLower = asset.content.toLowerCase();
      const sourceUrlLower = (asset.metadata.sourceUrl || '').toLowerCase();
      let keywordMatches = 0;
      let isUrlMatch = false;

      queryTokens.forEach(t => {
        if (titleLower.includes(t)) {
          keywordMatches += 1.5; // High boost for matching title keywords
        }
        if (contentLower.includes(t)) {
          try {
            // Check if it's a full word match
            const escapedToken = t.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
            const wordRegex = new RegExp('\\b' + escapedToken + '\\b', 'i');
            if (wordRegex.test(contentLower)) {
              keywordMatches += 1.0;
            } else {
              keywordMatches += 0.5; // Substring match
            }
          } catch {
            keywordMatches += 0.4;
          }
        }
        // Special boost for URL matching (e.g. matching domain/path of a URL)
        if (sourceUrlLower.includes(t) || (contentLower.includes('http') && contentLower.includes(t))) {
          keywordMatches += 1.5;
          isUrlMatch = true;
        }
        
        // Simple stemming/fuzzy prefix match (e.g. "flight" shares "fli" root)
        if (t.length >= 3) {
          const root = t.substring(0, 3);
          if (titleLower.includes(root) || contentLower.includes(root)) {
            keywordMatches += 0.5;
          }
        }
      });
      score += (keywordMatches * 0.4);

      // Only apply recency boost if there is some connection/match
      if (score > 0) {
        score += recencyBoost;
      }

      // 3. Asset Type Priority Boost (prefer rich parsed assets over raw clipboard log noise)
      if (asset.type === 'download' || asset.type === 'note' || asset.type === 'screenshot') {
        score += 0.3;
      } else if (isUrlMatch) {
        score += 0.5;
      }

      return { asset, score };
    });

    // Sort descending by relevance score, filtering out absolute zero relevance
    return results
      .filter(r => r.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
