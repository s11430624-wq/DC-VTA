type SearchItem = {
    title: string;
    link: string;
    snippet: string;
};

const getSerpApiKey = () => process.env.SERPAPI_API_KEY || '';
const DEFAULT_WEATHER_LOCATION = '台灣台中霧峰';

const hasLocationHint = (text: string) => /(台灣|臺灣|台中|臺中|霧峰|taiwan|taichung|wufeng|台北|臺北|高雄|台南|臺南|新北|桃園|新竹|苗栗|彰化|南投|雲林|嘉義|屏東|宜蘭|花蓮|台東|臺東|澎湖|金門|馬祖)/i.test(text);
const isWeatherQuery = (text: string) => /(天氣|氣溫|溫度|降雨|下雨|濕度|風速|weather|forecast|rain|temperature)/i.test(text);

const normalizeSearchQuery = (question: string) => {
    if (isWeatherQuery(question) && !hasLocationHint(question)) {
        return `${DEFAULT_WEATHER_LOCATION} ${question}`;
    }
    return question;
};

const shouldSearchByRegex = (question: string) => {
    const q = question.toLowerCase();
    return /(今天|最新|新聞|最近|即時|查一下|幫我查|是什麼|誰是|多少錢|價格|release|version|news|latest|current|today|what is|who is)/i.test(q);
};

export async function shouldUseWebSearch(question: string): Promise<boolean> {
    if (!getSerpApiKey()) return false;
    return shouldSearchByRegex(question);
}

export async function searchWeb(question: string, limit = 5): Promise<SearchItem[]> {
    const apiKey = getSerpApiKey();
    if (!apiKey) {
        return [];
    }

    const normalizedQuery = normalizeSearchQuery(question);
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('engine', 'google');
    url.searchParams.set('q', normalizedQuery);
    url.searchParams.set('hl', 'zh-tw');
    url.searchParams.set('num', String(Math.max(1, Math.min(limit, 10))));
    url.searchParams.set('api_key', apiKey);

    const response = await fetch(url.toString(), {
        method: 'GET',
    });

    if (!response.ok) {
        throw new Error(`SerpAPI 搜尋失敗：HTTP ${response.status}`);
    }

    const data = (await response.json()) as {
        organic_results?: Array<{
            title?: string;
            link?: string;
            snippet?: string;
        }>;
    };

    return (data.organic_results ?? [])
        .slice(0, limit)
        .map((item) => ({
            title: (item.title ?? '').trim(),
            link: (item.link ?? '').trim(),
            snippet: (item.snippet ?? '').trim(),
        }))
        .filter((item) => item.title.length > 0 && item.link.length > 0);
}

export const formatWebSearchSummary = (items: SearchItem[]) => {
    if (items.length === 0) return '（無）';
    return items
        .map((item, index) => `${index + 1}. ${item.title}\n網址: ${item.link}\n摘要: ${item.snippet || '（無摘要）'}`)
        .join('\n\n');
};
