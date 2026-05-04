import { createClient } from '@supabase/supabase-js'

process.loadEnvFile()

const SUPABASE_URL = process.env.VITE_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

async function test() {
    const { data: q, error: qe } = await supabase.from('quiz_responses').select('*').limit(1)
    console.log('Quiz Responses columns:', q ? Object.keys(q[0]) : qe)

    const { data: qdata } = await supabase.from('quiz_responses').select('*').limit(3)
    console.log('Quiz Responses sample:', qdata)

    const { data: g, error: ge } = await supabase.from('group_leaderboard').select('*').limit(1)
    console.log('Group Leaderboard columns:', g ? Object.keys(g[0]) : ge)

    const { data: qb, error: qbe } = await supabase.from('question_bank').select('*').limit(1)
    console.log('question_bank columns:', qb ? Object.keys(qb[0]) : qbe)
}
test()
