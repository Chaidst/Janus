/**
 * MediaSearchService — fetches images via Vertex AI Search and videos via YouTube Data API.
 *
 * IMAGE SEARCH STRATEGY (bulletproof):
 *   1. Send the RAW query to Vertex AI Search (no modifiers – modifiers pollute results)
 *   2. Run every result through a 3-layer filter:
 *        Layer 1 – Domain blocklist  (play store, .gov, colab, etc.)
 *        Layer 2 – Title blocklist   (sign in, help center, privacy, etc.)
 *        Layer 3 – Image-URL check   (must actually resolve to an image)
 *   3. Score surviving candidates by relevance (title overlap with query)
 *   4. Return the highest-scoring candidate, preferring non-google domains
 *   5. If absolutely nothing survives, return null (caller can fall back to Imagen)
 */
import { SearchServiceClient } from '@google-cloud/discoveryengine';

export interface ImageResult {
    url: string;
    title: string;
    source: string;
}

export interface VideoResult {
    videoId: string;
    title: string;
    thumbnail: string;
}

// ─── BLOCKLISTS ──────────────────────────────────────────────────────────────

/** Domains that NEVER contain useful images */
const BLOCKED_DOMAINS: string[] = [
    // App stores
    'play.google.com',
    'apps.apple.com',
    'chrome.google.com',
    'chromewebstore.google.com',
    // Google services that aren't image sources
    'google.com/maps',
    'google.com/earth',
    'google.com/search',
    'google.com/travel',
    'google.com/flights',
    'google.com/profiles',
    'google.com/intl',
    'accounts.google.com',
    'support.google.com',
    'scholar.google',
    'groups.google.com',
    'docs.google.com',
    'drive.google.com',
    'mail.google.com',
    'translate.google.com',
    'calendar.google.com',
    'meet.google.com',
    'classroom.google.com',
    // Google product pages
    'pixel.google',
    'blog.google',
    'gemini.google',
    'store.google',
    'about.google',
    'cloud.google.com/blog',
    'developers.google.com',
    'colab.research.google',
    // YouTube watch pages (not images)
    'youtube.com/watch',
    'youtube.com/playlist',
    'youtube.com/channel',
    // Government / regulatory
    '.gov',
    'ftc.gov',
    'congress.gov',
    'whitehouse.gov',
    // Social media profiles (icons, not images)
    'twitter.com',
    'x.com',
    'facebook.com',
    'instagram.com',
    'linkedin.com',
    'reddit.com',
    // Other junk
    'stackoverflow.com',
    'github.com',
    'npmjs.com',
    'pypi.org',
];

/** Title keywords that signal the page is NOT an image source */
const BLOCKED_TITLE_KEYWORDS: string[] = [
    // Auth / account pages
    'sign in', 'log in', 'login', 'sign up', 'create account',
    // Help / support
    'help center', 'help -', '- help', 'support', 'troubleshoot',
    'community', 'forum', 'discussion',
    // Legal / regulatory
    'coppa', 'ftc', 'compliance', 'regulatory', 'privacy policy',
    'terms of service', 'terms and conditions', 'cookie policy',
    // App stores
    'google play', 'app store', 'chrome web store',
    // Product marketing
    'video generation', 'ai model', 'release notes', 'changelog',
    // Technical junk
    'ipynb', 'notebook', '.js', '.ts', '.py', 'stack overflow',
    'github', 'npm',
    // Misc noise
    'faq', 'frequently asked',
];

/** Known image-hosting domains (get a bonus score) */
const IMAGE_HOSTING_DOMAINS: string[] = [
    'unsplash.com', 'pexels.com', 'flickr.com', 'pixabay.com',
    'static01.nyt.com', 'media.cnn.com', 'ichef.bbci.co.uk',
    'upload.wikimedia.org', 'images.unsplash.com',
    'i.imgur.com', 'media.gettyimages.com',
    'nationalgeographic.com', 'smithsonianmag.com',
    'artsandculture.google.com',
];


export class MediaSearchService {
    private searchClient: SearchServiceClient;
    private vertexProjectId: string;
    private vertexLocation: string;
    private vertexDataStoreId: string;
    private youtubeApiKey: string;

    constructor() {
        this.searchClient = new SearchServiceClient();
        this.vertexProjectId = process.env.VERTEX_AI_SEARCH_PROJECT_ID || '';
        this.vertexLocation = process.env.VERTEX_AI_SEARCH_LOCATION || '';
        this.vertexDataStoreId = process.env.VERTEX_AI_SEARCH_DATA_STORE_ID || '';
        this.youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
    }

    // ─── IMAGE SEARCH (BULLETPROOF) ──────────────────────────────────────────

    /**
     * Search for images via Vertex AI Search.
     * Uses the RAW query (no modifiers) and relies on multi-layer filtering.
     */
    async searchImage(query: string): Promise<ImageResult | null> {
        if (!this.vertexProjectId || !this.vertexLocation || !this.vertexDataStoreId) {
            console.warn('MediaSearchService: Missing Vertex AI Search configuration');
            return null;
        }

        // ── STEP 1: Search with the raw query (no modifiers!) ────────────
        // Modifiers like "illustration for kids" or "high resolution photo"
        // POLLUTE the search and pull back random unrelated pages. The raw
        // query is what the user/Gemini actually wants to find.
        const safeQuery = `${query} photo`;

        try {
            const servingConfig = this.searchClient.projectLocationCollectionDataStoreServingConfigPath(
                this.vertexProjectId,
                this.vertexLocation,
                'default_collection',
                this.vertexDataStoreId,
                'default_search'
            );

            const request = {
                servingConfig,
                query: safeQuery,
                pageSize: 20,
            };

            const [results] = await this.searchClient.search(request, { autoPaginate: false });

            if (!results || results.length === 0) {
                console.warn('MediaSearchService: Vertex AI Search returned 0 results');
                return null;
            }

            // ── STEP 2: Filter and score candidates ──────────────────────
            type ScoredCandidate = ImageResult & { score: number };
            const candidates: ScoredCandidate[] = [];

            for (const res of results) {
                const doc = res.document;
                const pb = doc?.derivedStructData?.fields;
                const rawTitle = pb?.title?.stringValue || pb?.htmlTitle?.stringValue || '';
                const titleStr = rawTitle.toLowerCase();
                const link = (pb?.link?.stringValue || '').toLowerCase();

                // ── Layer 1: Domain blocklist ────────────────────────────
                if (BLOCKED_DOMAINS.some(d => link.includes(d))) {
                    continue;
                }

                // ── Layer 2: Title keyword blocklist ─────────────────────
                if (BLOCKED_TITLE_KEYWORDS.some(kw => titleStr.includes(kw))) {
                    continue;
                }

                // ── Layer 3: Extract an actual image URL ─────────────────
                const pm = pb?.pagemap?.structValue?.fields;
                const imageUrl = this.extractBestImageUrl(pm, pb);

                if (!imageUrl) {
                    continue; // no usable image URL in this result
                }

                // ── Score this candidate ─────────────────────────────────
                let score = 0;

                // Bonus for non-google domains (more likely to be real content)
                if (!link.includes('google.com') && !link.includes('google.')) {
                    score += 10;
                }

                // Bonus for known image-hosting domains
                if (IMAGE_HOSTING_DOMAINS.some(d => link.includes(d) || imageUrl.includes(d))) {
                    score += 15;
                }

                // Bonus for Google Arts & Culture (high-quality curated images)
                if (link.includes('artsandculture.google.com')) {
                    score += 12;
                }

                // Bonus for title containing query words
                const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                const titleMatchCount = queryWords.filter(w => titleStr.includes(w)).length;
                score += titleMatchCount * 5;

                // Bonus for link containing query words
                const linkMatchCount = queryWords.filter(w => link.includes(w)).length;
                score += linkMatchCount * 3;

                // Bonus for image URL being a direct image file
                if (imageUrl.match(/\.(jpeg|jpg|png|webp|gif)/i)) {
                    score += 3;
                }

                // Bonus for large thumbnail (indicates real image, not icon)
                const thumbWidth = pm?.cse_thumbnail?.listValue?.values?.[0]?.structValue?.fields?.width?.stringValue;
                if (thumbWidth && parseInt(thumbWidth) > 200) {
                    score += 5;
                }

                candidates.push({
                    url: imageUrl,
                    title: rawTitle || query,
                    source: 'Vertex AI Search',
                    score,
                });
            }

            // ── STEP 3: Return the best candidate ────────────────────────
            if (candidates.length === 0) {
                console.warn(`MediaSearchService: All ${results.length} results were filtered out for "${query}"`);
                return null;
            }

            // Sort by score descending
            candidates.sort((a, b) => b.score - a.score);

            const best = candidates[0]!;
            console.log(`MediaSearchService: Selected "${best.title}" (score: ${best.score}) from ${candidates.length} candidates for "${query}"`);
            return {
                url: best.url,
                title: best.title,
                source: best.source,
            };

        } catch (error) {
            console.error('MediaSearchService: Vertex Image search failed:', error);
            return null;
        }
    }

    /**
     * Extract the best image URL from a search result's pagemap data.
     * Checks multiple sources in priority order.
     */
    private extractBestImageUrl(
        pm: any,
        pb: any,
    ): string | null {
        const rawCandidates: string[] = [];

        // og:image from metatags (usually high quality)
        const ogImage = pm?.metatags?.listValue?.values?.[0]?.structValue?.fields?.['og:image']?.stringValue;
        if (ogImage) rawCandidates.push(ogImage);

        // twitter:image
        const twitterImage = pm?.metatags?.listValue?.values?.[0]?.structValue?.fields?.['twitter:image']?.stringValue;
        if (twitterImage) rawCandidates.push(twitterImage);

        // cse_image
        const cseImage = pm?.cse_image?.listValue?.values?.[0]?.structValue?.fields?.src?.stringValue;
        if (cseImage) rawCandidates.push(cseImage);

        // cse_thumbnail
        const cseThumbnail = pm?.cse_thumbnail?.listValue?.values?.[0]?.structValue?.fields?.src?.stringValue;
        if (cseThumbnail) rawCandidates.push(cseThumbnail);

        // Direct link
        const directLink = pb?.link?.stringValue || '';
        if (directLink) rawCandidates.push(directLink);

        // ── Normalize and validate URLs ──────────────────────────────
        // Pass 1: prefer URLs with real image extensions (most reliable)
        for (const url of rawCandidates) {
            if (!url || typeof url !== 'string') continue;
            if (url.match(/\.(jpeg|jpg|gif|png|webp|svg|bmp)/i)) {
                return this.normalizeImageUrl(url);
            }
        }

        // Pass 2: accept Google CDN URLs (need size param to load)
        for (const url of rawCandidates) {
            if (!url || typeof url !== 'string') continue;
            if (url.includes('googleusercontent.com') || 
                url.includes('encrypted-tbn0.gstatic.com') ||
                url.includes('ggpht.com')) {
                return this.normalizeImageUrl(url);
            }
        }

        // Pass 3: accept URLs with known image path patterns
        for (const url of rawCandidates) {
            if (!url || typeof url !== 'string') continue;
            if (url.includes('/images/') || 
                url.includes('/image/') || 
                url.includes('/img/') || 
                url.includes('/photos/') ||
                url.includes('/photo/') ||
                url.includes('i.ytimg.com') ||
                url.includes('static') ||
                url.includes('media') ||
                url.includes('cdn')) {
                return this.normalizeImageUrl(url);
            }
        }

        return null;
    }

    /**
     * Normalize an image URL so it actually loads in a browser.
     * - Google's lh3.googleusercontent.com/ci/ URLs need a size suffix (=w1280)
     * - Google's lh3.googleusercontent.com/ URLs need =w1280 if no size set
     * - Relative URLs get skipped
     */
    private normalizeImageUrl(url: string): string {
        // Skip relative URLs
        if (!url.startsWith('http')) {
            return url;
        }

        // Google's image CDN requires a size parameter to serve the image
        // Without it, the URL returns nothing or a tiny placeholder
        if (url.includes('googleusercontent.com')) {
            // Don't add if already has a size parameter
            if (!url.includes('=w') && !url.includes('=s') && !url.includes('=h')) {
                return `${url}=w1280`;
            }
        }

        return url;
    }

    // ─── VIDEO SEARCH ────────────────────────────────────────────────────────

    /**
     * Search YouTube videos via YouTube Data API v3.
     * Returns the top video result or null if nothing found.
     */
    async searchVideo(query: string): Promise<VideoResult | null> {
        if (!this.youtubeApiKey) {
            console.warn('MediaSearchService: Missing YOUTUBE_API_KEY');
            return null;
        }

        const safeQuery = `${query} for kids`;
        const url = `https://www.googleapis.com/youtube/v3/search?` +
            `key=${encodeURIComponent(this.youtubeApiKey)}` +
            `&q=${encodeURIComponent(safeQuery)}` +
            `&part=snippet` +
            `&type=video` +
            `&safeSearch=strict` +
            `&maxResults=1`;

        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data.items && data.items.length > 0) {
                const item = data.items[0];
                return {
                    videoId: item.id.videoId,
                    title: item.snippet.title,
                    thumbnail: item.snippet.thumbnails?.medium?.url || '',
                };
            } else {
                console.warn('MediaSearchService: YouTube API returned no items. Response:', JSON.stringify(data, null, 2));
            }
            return null;
        } catch (error) {
            console.error('MediaSearchService: Video search failed:', error);
            return null;
        }
    }

    // ─── UTILITIES ───────────────────────────────────────────────────────────

    /**
     * Detect if a query is complex (multiple subjects) and might need generation.
     */
    isComplexQuery(query: string): boolean {
        const lower = query.toLowerCase();
        return lower.includes(' and ') || lower.includes(' together') || lower.includes(',') || (lower.match(/\w+/g) || []).length > 5;
    }
}
