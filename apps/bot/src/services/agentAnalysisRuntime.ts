export type AgentAnalysisIntent =
    | 'class_overview'
    | 'mistake_hotspots'
    | 'student_observation'
    | 'question_quality_check'
    | 'rank_interpretation'
    | 'student_self_diagnosis'
    | 'student_weakness_summary'
    | 'student_review_coach'
    | 'question_generation'
    | 'capability'
    | 'poll_creation'
    | 'survey_creation'
    | 'batch_generation'
    | 'general_chat';

export type AgentIntentResolution = {
    intent: AgentAnalysisIntent;
};

export type StudentScopeGuardResult = {
    denied: boolean;
    reason: string;
};

type StructuredReplyInput = {
    summary: string;
    findings: string[];
    suggestions: string[];
    caveat?: string | null;
};

const CAPABILITY_PATTERN = /(你會做什麼|你能做什麼|可以做什麼|有哪些功能|幫助|\/help|help|指令(列表|說明)?)/i;
const BATCH_GENERATION_PATTERN = /(出.{0,4}[2-5]題|[2-5]題.*出題|批次出題|一次出.*題|多題題目)/i;
const QUESTION_GENERATION_PATTERN = /(出題|生成.*題|產生.*題|題目草稿|出一題|幫我寫一題|簡答題|選擇題|單選題|四選一|問答題|申論題)/i;
const POLL_PATTERN = /(投票|poll).*(建立|新增|做|產生|生成|create|add)|((建立|新增|做|產生|生成|create|add).*(投票|poll))/i;
const SURVEY_PATTERN = /(問卷|survey).*(建立|新增|出題|出|產生|生成|create|add)|((建立|新增|出題|出|產生|生成|create|add).*(問卷|survey))/i;
const CLASS_OVERVIEW_PATTERN = /(全班|班級|整班).*(狀況|情況|表現|總覽|概況|分析|摘要)|((這週|最近).*(全班|班級).*(狀況|表現|概況))/i;
const MISTAKE_HOTSPOT_PATTERN = /(最多人錯|最常錯|錯最多|錯題熱點|哪些題.*錯|哪幾題.*錯|常錯題)/i;
const QUESTION_QUALITY_PATTERN = /(題目).*(品質|太難|太簡單|鑑別度|有問題|需要重寫)|((太難|太簡單|鑑別度).*(題目))/i;
const RANK_INTERPRETATION_PATTERN = /(排行榜).*(解讀|分析|怎麼看|如何看)|((前幾名|排行).*(分析|解讀))/i;
const STUDENT_OBSERVATION_PATTERN = /(觀察|看看|分析一下|分析看看|關注).*(學生|同學|最近|表現|狀況)|([一-龥]{2,12}).*(最近|表現|狀況|成績)/i;
const SELF_DIAGNOSIS_PATTERN = /(我的成績|我的表現|我最近|自我診斷|分析我|我的狀況|我表現如何)/i;
const WEAKNESS_PATTERN = /(哪裡最弱|弱點|常錯|錯題整理|我哪一塊弱|我哪裡弱)/i;
const REVIEW_COACH_PATTERN = /(該先複習什麼|先補哪裡|怎麼進步|怎麼複習|學習建議|複習建議|粗心|教練|下週先補)/i;
const STUDENT_SCOPE_BLOCK_PATTERN = /(其他同學|別人|他人|王小明|李小華|全班|整班|排行榜前|某同學|那位同學|那個學生)/i;
const STUDENT_SCOPE_BLOCK_STUDENT_ID_PATTERN = /\b\d{4,12}\b/;

export function shouldDenyStudentScope(question: string): StudentScopeGuardResult {
    const trimmed = question.trim();
    if (/(我|自己|我的)/.test(trimmed)) {
        return {
            denied: false,
            reason: '',
        };
    }

    const denied = STUDENT_SCOPE_BLOCK_PATTERN.test(trimmed) || STUDENT_SCOPE_BLOCK_STUDENT_ID_PATTERN.test(trimmed);
    return {
        denied,
        reason: denied ? '學生模式只能查詢你自己的資料；若你想看自己的表現，我可以直接幫你做個人診斷。' : '',
    };
}

export function resolveAgentIntent(question: string, isTeacher: boolean): AgentIntentResolution {
    const text = question.trim();

    if (CAPABILITY_PATTERN.test(text)) return { intent: 'capability' };
    if (POLL_PATTERN.test(text)) return { intent: 'poll_creation' };
    if (SURVEY_PATTERN.test(text)) return { intent: 'survey_creation' };
    if (BATCH_GENERATION_PATTERN.test(text)) return { intent: 'batch_generation' };
    if (QUESTION_GENERATION_PATTERN.test(text)) return { intent: 'question_generation' };

    if (isTeacher) {
        if (MISTAKE_HOTSPOT_PATTERN.test(text)) return { intent: 'mistake_hotspots' };
        if (QUESTION_QUALITY_PATTERN.test(text)) return { intent: 'question_quality_check' };
        if (RANK_INTERPRETATION_PATTERN.test(text)) return { intent: 'rank_interpretation' };
        if (CLASS_OVERVIEW_PATTERN.test(text)) return { intent: 'class_overview' };
        if (STUDENT_OBSERVATION_PATTERN.test(text)) return { intent: 'student_observation' };
        if (/(最近表現|最近狀況|班上狀況|整體表現)/i.test(text)) return { intent: 'class_overview' };
        return { intent: 'general_chat' };
    }

    if (REVIEW_COACH_PATTERN.test(text)) return { intent: 'student_review_coach' };
    if (WEAKNESS_PATTERN.test(text)) return { intent: 'student_weakness_summary' };
    if (SELF_DIAGNOSIS_PATTERN.test(text)) return { intent: 'student_self_diagnosis' };
    if (/(最近表現|最近狀況|幫我看一下|分析一下我)/i.test(text)) return { intent: 'student_self_diagnosis' };
    return { intent: 'general_chat' };
}

export function formatAgentStructuredReply(input: StructuredReplyInput): string {
    const findings = input.findings.slice(0, 4).map((item) => `- ${item}`).join('\n');
    const suggestions = input.suggestions.slice(0, 3).map((item) => `- ${item}`).join('\n');
    const sections = [
        `結論\n${input.summary}`,
        `關鍵發現\n${findings || '- 目前沒有足夠資料可列出重點。'}`,
        `下一步建議\n${suggestions || '- 目前先補充更多作答資料後再分析。'}`,
    ];

    if (input.caveat?.trim()) {
        sections.push(`資料提醒\n${input.caveat.trim()}`);
    }

    return sections.join('\n\n');
}
