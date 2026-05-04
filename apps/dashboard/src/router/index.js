import { createRouter, createWebHistory } from 'vue-router'


const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/student-quiz',
      name: 'student-quiz',
      // 學生簡答題作答頁面（LINE LIFF 專用，lazy-loaded）
      component: () => import('../components/StudentQuiz.vue'),
    },
  ],
})

export default router
