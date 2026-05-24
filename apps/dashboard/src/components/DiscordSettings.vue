<script setup>
import { computed, onMounted, onUnmounted, ref, inject } from 'vue'
import { supabase } from '../supabase'
import { RefreshCw, Save, Trash2, PlusCircle, ServerCog, Globe } from 'lucide-vue-next'

const loading = ref(false)
const saving = ref(false)
const rows = ref([])
const lastSyncedAt = ref(null)
let guildSettingsChannel = null
const pendingDeleteGuildIds = ref([])

const emptyRow = () => ({
  guild_id: '',
  guild_name: '',
  teacher_role_id: '',
  teacher_log_channel_id: '',
  command_audit_channel_id: '',
  _originGuildId: '',
  _localOnly: true,
  _pendingDelete: false,
})

const canAdd = computed(() => rows.value.every((row) => row.guild_id.trim().length > 0))

const uiVariant = inject('uiVariant', ref('classic'))

async function fetchGuildSettings() {
  loading.value = true
  const { data, error } = await supabase
    .from('guild_settings')
    .select('guild_id, guild_name, teacher_role_id, teacher_log_channel_id, command_audit_channel_id, updated_at')
    .order('updated_at', { ascending: false })

  if (error) {
    console.error('載入 guild_settings 失敗:', error)
    alert('載入 Discord 設定失敗: ' + error.message)
  } else {
    rows.value = (data || []).map((item) => ({
      guild_id: item.guild_id ?? '',
      guild_name: item.guild_name ?? '',
      teacher_role_id: item.teacher_role_id ?? '',
      teacher_log_channel_id: item.teacher_log_channel_id ?? '',
      command_audit_channel_id: item.command_audit_channel_id ?? '',
      _originGuildId: item.guild_id ?? '',
      _localOnly: false,
      _pendingDelete: false,
    }))
    if (rows.value.length === 0) {
      rows.value = [emptyRow()]
    }
    lastSyncedAt.value = new Date()
  }
  loading.value = false
}

function addRow() {
  rows.value.push(emptyRow())
}

function removeRow(index) {
  const row = rows.value[index]
  if (!row) return

  if (row._localOnly || !row.guild_id?.trim()) {
    rows.value.splice(index, 1)
  } else {
    row._pendingDelete = !row._pendingDelete
    const guildId = (row._originGuildId || row.guild_id || '').trim()
    if (row._pendingDelete) {
      if (!pendingDeleteGuildIds.value.includes(guildId)) {
        pendingDeleteGuildIds.value.push(guildId)
      }
    } else {
      pendingDeleteGuildIds.value = pendingDeleteGuildIds.value.filter((id) => id !== guildId)
    }
  }

  if (rows.value.length === 0) {
    rows.value.push(emptyRow())
  }
}

async function saveAll() {
  // Rows that exist in DB but were edited to blank guild_id should still be treated as pending delete targets.
  for (const row of rows.value) {
    const originGuildId = (row._originGuildId || '').trim()
    if (!originGuildId) continue
    if (row._pendingDelete || row.guild_id.trim().length === 0) {
      if (!pendingDeleteGuildIds.value.includes(originGuildId)) {
        pendingDeleteGuildIds.value.push(originGuildId)
      }
      row._pendingDelete = true
    }
  }

  if (pendingDeleteGuildIds.value.length > 0) {
    const confirmed = window.confirm(
      `你即將刪除 ${pendingDeleteGuildIds.value.length} 筆 Discord 設定，確定要繼續嗎？`,
    )
    if (!confirmed) {
      return
    }
  }

  const payload = rows.value
    .map((row) => ({
      guild_id: row.guild_id.trim(),
      guild_name: row.guild_name.trim() || null,
      teacher_role_id: row.teacher_role_id.trim() || null,
      teacher_log_channel_id: row.teacher_log_channel_id.trim() || null,
      command_audit_channel_id: row.command_audit_channel_id.trim() || null,
      _pendingDelete: row._pendingDelete === true,
    }))
    .filter((row) => row.guild_id.length > 0 && !row._pendingDelete)

  // Allow saving an empty table (delete-all scenario). No minimum row constraint.

  saving.value = true
  let saveError = null

  if (payload.length > 0) {
    const upsertPayload = payload.map(({ _pendingDelete, ...row }) => row)
    const { error } = await supabase.from('guild_settings').upsert(upsertPayload, { onConflict: 'guild_id' })
    if (error) {
      saveError = error
    }
  }

  if (!saveError && pendingDeleteGuildIds.value.length > 0) {
    const { error } = await supabase
      .from('guild_settings')
      .delete()
      .in('guild_id', pendingDeleteGuildIds.value)
    if (error) {
      saveError = error
    }
  }

  saving.value = false

  if (saveError) {
    console.error('儲存 guild_settings 失敗:', saveError)
    alert('儲存失敗: ' + saveError.message)
    return
  }

  pendingDeleteGuildIds.value = []
  alert('✅ Discord 設定已儲存')
  await fetchGuildSettings()
}

onMounted(fetchGuildSettings)
onMounted(() => {
  guildSettingsChannel = supabase
    .channel('guild_settings_sync')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'guild_settings' },
      async () => {
        await fetchGuildSettings()
      },
    )
    .subscribe()
})

onUnmounted(() => {
  if (guildSettingsChannel) {
    supabase.removeChannel(guildSettingsChannel)
    guildSettingsChannel = null
  }
})
</script>

<template>
  <div class="space-y-5">
    <!-- ============================================== -->
    <!-- Option A: Redesigned UI (Academic Workbench) -->
    <!-- ============================================== -->
    <div v-if="uiVariant === 'redesigned'" class="space-y-5">
      <!-- Title Block -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-white p-4 rounded-xl border border-slate-200/60 shadow-academic">
        <div class="flex items-center gap-2.5">
          <div class="p-2 bg-blue-50 text-blue-600 rounded-lg">
            <ServerCog class="w-5 h-5 sm:w-6 sm:h-6" />
          </div>
          <div>
            <h2 class="text-base sm:text-lg font-bold text-slate-800 tracking-wide font-sans">Discord 伺服器設定</h2>
            <p class="text-[10px] sm:text-xs text-slate-400 font-medium">配置機器人對接之 Guild ID、角色權限與審計日誌頻道</p>
          </div>
        </div>
        
        <div class="flex items-center gap-2 w-full sm:w-auto">
          <button
            @click="fetchGuildSettings"
            :disabled="loading || saving"
            class="flex-1 sm:flex-none justify-center px-4 py-2 border border-slate-250/80 text-slate-700 bg-white hover:bg-slate-50 rounded-xl transition-smooth inline-flex items-center gap-2 text-sm font-semibold disabled:opacity-50 btn-academic-active touch-target"
          >
            <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
            <span>重新整理</span>
          </button>
          <button
            @click="saveAll"
            :disabled="loading || saving"
            class="flex-1 sm:flex-none justify-center px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl transition-smooth inline-flex items-center gap-2 text-sm font-semibold disabled:opacity-50 shadow-sm shadow-blue-500/10 btn-academic-active touch-target"
          >
            <Save class="w-4 h-4" />
            <span>儲存全部</span>
          </button>
        </div>
      </div>

      <!-- Sync Status Pill & Guild Count -->
      <div v-if="lastSyncedAt" class="flex items-center gap-2 px-1 text-[11px] text-slate-450 font-bold uppercase tracking-wider">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-ping"></span>
        <span>已同步雲端資料庫：{{ lastSyncedAt.toLocaleTimeString() }}</span>
      </div>

      <!-- Configuration List -->
      <div v-if="loading" class="text-center py-16 bg-white rounded-2xl border border-slate-200/60 shadow-academic text-slate-400">
        <RefreshCw class="w-8 h-8 animate-spin mx-auto mb-3 text-blue-600" />
        <p class="font-medium text-sm">正在載入伺服器對接端點...</p>
      </div>

      <div v-else class="space-y-4">
        <!-- Mobile View (lg:hidden) - Individual Form Cards -->
        <div class="lg:hidden space-y-4">
          <div
            v-for="(row, index) in rows"
            :key="`guild-mobile-row-${index}`"
            class="bg-white rounded-2xl border p-4 sm:p-5 shadow-academic flex flex-col gap-4 relative transition-smooth"
            :class="row._pendingDelete ? 'bg-red-50/40 border-red-200' : 'border-slate-200/60'"
          >
            <!-- Card Header -->
            <div class="flex items-center justify-between pb-3 border-b border-slate-100">
              <div class="flex items-center gap-2">
                <Globe class="w-4.5 h-4.5 text-blue-550" />
                <span class="font-bold text-slate-800 text-sm">對接伺服器 #{{ index + 1 }}</span>
              </div>
              <button 
                @click="removeRow(index)" 
                class="p-2 text-red-600 hover:bg-red-50 rounded-xl transition-smooth touch-target flex items-center justify-center btn-academic-active border border-transparent hover:border-red-100" 
                :title="row._pendingDelete ? '取消刪除' : '標記刪除'"
              >
                <Trash2 class="w-4.5 h-4.5" />
              </button>
            </div>

            <!-- Flag Overlay -->
            <div v-if="row._pendingDelete" class="bg-red-100/70 text-red-800 px-3 py-2 rounded-xl text-xs font-bold border border-red-200 flex items-center gap-1.5 animate-pulse">
              ⚠️ 此伺服器設定已標記為待刪除。按下「儲存全部」後生效。
            </div>

            <!-- Form Content Fields -->
            <div class="space-y-3 text-xs sm:text-sm">
              <div class="flex flex-col gap-1">
                <label class="font-bold text-slate-500">Guild ID (伺服器編號) *</label>
                <input 
                  v-model="row.guild_id" 
                  :disabled="row._pendingDelete" 
                  class="w-full bg-slate-50/50 border border-slate-200/80 rounded-xl px-3 py-2.5 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400 transition-smooth font-semibold text-slate-700 min-h-[44px]" 
                  placeholder="例：98127391238..." 
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="font-bold text-slate-500">Guild Name (名稱)</label>
                <input 
                  v-model="row.guild_name" 
                  :disabled="row._pendingDelete" 
                  class="w-full bg-slate-50/50 border border-slate-200/80 rounded-xl px-3 py-2.5 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400 transition-smooth font-semibold text-slate-700 min-h-[44px]" 
                  placeholder="例：資訊科學班" 
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="font-bold text-slate-500">Teacher Role ID (教師角色編號)</label>
                <input 
                  v-model="row.teacher_role_id" 
                  :disabled="row._pendingDelete" 
                  class="w-full bg-slate-50/50 border border-slate-200/80 rounded-xl px-3 py-2.5 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400 transition-smooth font-semibold text-slate-700 min-h-[44px]" 
                  placeholder="教師身份組 ID" 
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="font-bold text-slate-500">Teacher Log Channel ID (批改日誌頻道)</label>
                <input 
                  v-model="row.teacher_log_channel_id" 
                  :disabled="row._pendingDelete" 
                  class="w-full bg-slate-50/50 border border-slate-200/80 rounded-xl px-3 py-2.5 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400 transition-smooth font-semibold text-slate-700 min-h-[44px]" 
                  placeholder="批改日誌發送頻道 ID" 
                />
              </div>

              <div class="flex flex-col gap-1">
                <label class="font-bold text-slate-500">Command Audit Channel ID (指令紀錄頻道)</label>
                <input 
                  v-model="row.command_audit_channel_id" 
                  :disabled="row._pendingDelete" 
                  class="w-full bg-slate-50/50 border border-slate-200/80 rounded-xl px-3 py-2.5 outline-none focus:bg-white focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 disabled:bg-slate-100 disabled:text-slate-400 transition-smooth font-semibold text-slate-700 min-h-[44px]" 
                  placeholder="Audit Log 頻道 ID" 
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Desktop View (lg:table-block) - High Fidelity Data Grid Table -->
        <div class="hidden lg:block bg-white border border-slate-200/60 rounded-2xl overflow-hidden shadow-academic">
          <div class="grid grid-cols-12 bg-slate-50/80 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
            <div class="col-span-2 px-4 py-3">Guild ID *</div>
            <div class="col-span-2 px-3 py-3">伺服器名稱</div>
            <div class="col-span-2 px-3 py-3">教師角色 ID</div>
            <div class="col-span-2 px-3 py-3">批改日誌頻道 ID</div>
            <div class="col-span-3 px-3 py-3">指令紀錄頻道 ID</div>
            <div class="col-span-1 px-3 py-3 text-center">操作</div>
          </div>

          <div class="divide-y divide-slate-100">
            <div
              v-for="(row, index) in rows"
              :key="`guild-desktop-row-${index}`"
              class="grid grid-cols-12 items-center hover:bg-slate-50/30 transition-colors"
              :class="row._pendingDelete ? 'bg-red-50/40 text-red-900' : ''"
            >
              <div class="col-span-2 p-2 px-4">
                <input v-model="row.guild_id" :disabled="row._pendingDelete" class="w-full bg-slate-50/60 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-750 focus:bg-white focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-smooth disabled:bg-slate-100 disabled:text-slate-400" placeholder="98127..." />
              </div>
              <div class="col-span-2 p-2">
                <input v-model="row.guild_name" :disabled="row._pendingDelete" class="w-full bg-slate-50/60 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-750 focus:bg-white focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-smooth disabled:bg-slate-100 disabled:text-slate-400" placeholder="測試伺服器" />
              </div>
              <div class="col-span-2 p-2">
                <input v-model="row.teacher_role_id" :disabled="row._pendingDelete" class="w-full bg-slate-50/60 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-750 focus:bg-white focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-smooth disabled:bg-slate-100 disabled:text-slate-400" placeholder="Role ID" />
              </div>
              <div class="col-span-2 p-2">
                <input v-model="row.teacher_log_channel_id" :disabled="row._pendingDelete" class="w-full bg-slate-50/60 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-750 focus:bg-white focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-smooth disabled:bg-slate-100 disabled:text-slate-400" placeholder="Channel ID" />
              </div>
              <div class="col-span-3 p-2">
                <input v-model="row.command_audit_channel_id" :disabled="row._pendingDelete" class="w-full bg-slate-50/60 border border-slate-200 rounded-xl px-3 py-2 text-xs font-semibold text-slate-750 focus:bg-white focus:ring-2 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-smooth disabled:bg-slate-100 disabled:text-slate-400" placeholder="Audit Channel ID" />
              </div>
              <div class="col-span-1 p-2 flex items-center justify-center">
                <button 
                  @click="removeRow(index)" 
                  class="p-2 text-red-650 hover:bg-red-50 rounded-xl transition-smooth btn-academic-active border border-transparent hover:border-red-100" 
                  :title="row._pendingDelete ? '取消刪除' : '標記刪除'"
                >
                  <Trash2 class="w-4 h-4" />
                </button>
              </div>
              
              <div v-if="row._pendingDelete" class="col-span-12 px-5 pb-2.5 text-xs text-red-600 font-bold animate-pulse">
                ⚠️ 此端點已標記為刪除，將在點擊「儲存全部」時自資料庫實體抹除。
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Add Guild Button -->
      <button
        @click="addRow"
        :disabled="!canAdd"
        class="w-full sm:w-auto px-5 py-3 border border-dashed border-slate-350 text-slate-650 rounded-2xl hover:bg-slate-50 hover:border-blue-300 transition-smooth inline-flex items-center justify-center gap-2 disabled:opacity-40 font-semibold btn-academic-active touch-target"
      >
        <PlusCircle class="w-4.5 h-4.5 text-slate-500" />
        <span>註冊新的 Discord 伺服器端點</span>
      </button>

      <!-- Context Helper Box -->
      <div class="bg-blue-50/50 p-4 rounded-2xl border border-blue-100/50 text-xs sm:text-sm text-slate-500 leading-relaxed font-semibold">
        💡 <b>設定指南：</b> 伺服器角色與批改日誌頻道 ID 可先留空，Bot 會 fallback 使用預設屬性。如有多個班級 (多個 Server) 請明確填入各欄位。
        Command Audit Channel ID 建議明確填入，機器人會依此進行指令紀錄及日誌轉載。
      </div>
    </div>

    <!-- ============================================== -->
    <!-- Option B: Classic UI (Original Layout)          -->
    <!-- ============================================== -->
    <div v-else class="space-y-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <ServerCog class="w-5 h-5 text-slate-700" />
          <h2 class="text-xl font-bold text-slate-800">Discord 伺服器設定</h2>
          <span v-if="lastSyncedAt" class="text-xs text-slate-500">
            已同步：{{ lastSyncedAt.toLocaleTimeString() }}
          </span>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="fetchGuildSettings"
            :disabled="loading || saving"
            class="px-3 py-2 border border-slate-300 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center gap-2 disabled:opacity-60"
          >
            <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': loading }" />
            重新整理
          </button>
          <button
            @click="saveAll"
            :disabled="loading || saving"
            class="px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors inline-flex items-center gap-2 disabled:opacity-60"
          >
            <Save class="w-4 h-4" />
            儲存全部
          </button>
        </div>
      </div>

      <div class="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div class="grid grid-cols-12 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
          <div class="col-span-2 px-3 py-2">guild_id</div>
          <div class="col-span-2 px-3 py-2">guild_name</div>
          <div class="col-span-2 px-3 py-2">teacher_role_id</div>
          <div class="col-span-2 px-3 py-2">teacher_log_channel_id</div>
          <div class="col-span-3 px-3 py-2">command_audit_channel_id</div>
          <div class="col-span-1 px-3 py-2 text-center">操作</div>
        </div>

        <div v-if="loading" class="px-4 py-8 text-center text-slate-500">載入中...</div>

        <div v-else>
          <div
            v-for="(row, index) in rows"
            :key="`guild-row-${index}`"
            :class="[
              'grid grid-cols-12 border-b border-slate-100 last:border-b-0',
              row._pendingDelete ? 'bg-rose-50/70' : '',
            ]"
          >
            <div class="col-span-2 p-2">
              <input v-model="row.guild_id" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="1500..." />
            </div>
            <div class="col-span-2 p-2">
              <input v-model="row.guild_name" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="VTA test" />
            </div>
            <div class="col-span-2 p-2">
              <input v-model="row.teacher_role_id" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="老師角色 ID" />
            </div>
            <div class="col-span-2 p-2">
              <input v-model="row.teacher_log_channel_id" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="teacher 頻道 ID" />
            </div>
            <div class="col-span-3 p-2">
              <input v-model="row.command_audit_channel_id" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="指令紀錄頻道 ID" />
            </div>
            <div class="col-span-1 p-2 flex items-center justify-center gap-1">
              <button @click="removeRow(index)" class="p-1.5 text-rose-600 hover:bg-rose-50 rounded" :title="row._pendingDelete ? '取消刪除' : '標記刪除'">
                <Trash2 class="w-4 h-4" />
              </button>
            </div>
            <div v-if="row._pendingDelete" class="col-span-12 px-3 pb-2 text-xs text-rose-700">
              此列已標記為刪除，按「儲存全部」後會從資料庫移除。
            </div>
          </div>
        </div>
      </div>

      <button
        @click="addRow"
        :disabled="!canAdd"
        class="px-3 py-2 border border-dashed border-slate-400 text-slate-700 rounded-lg hover:bg-slate-50 transition-colors inline-flex items-center gap-2 disabled:opacity-50"
      >
        <PlusCircle class="w-4 h-4" />
        新增伺服器設定
      </button>

      <p class="text-xs text-slate-500">
        teacher_role_id 與 teacher_log_channel_id 可先留空，Bot 會 fallback 到 .env 或同名 teacher 頻道；多班建議明確填入。command_audit_channel_id 建議明確填入，Bot 僅使用資料庫設定。
      </p>
    </div>
  </div>
</template>
