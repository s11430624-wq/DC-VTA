<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { supabase } from '../supabase'
import { RefreshCw, Save, Trash2, PlusCircle, ServerCog } from 'lucide-vue-next'

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
  _originGuildId: '',
  _localOnly: true,
  _pendingDelete: false,
})

const canAdd = computed(() => rows.value.every((row) => row.guild_id.trim().length > 0))

async function fetchGuildSettings() {
  loading.value = true
  const { data, error } = await supabase
    .from('guild_settings')
    .select('guild_id, guild_name, teacher_role_id, teacher_log_channel_id, updated_at')
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
  <div class="space-y-4">
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
        <div class="col-span-3 px-3 py-2">guild_id</div>
        <div class="col-span-3 px-3 py-2">guild_name</div>
        <div class="col-span-3 px-3 py-2">teacher_role_id</div>
        <div class="col-span-2 px-3 py-2">teacher_log_channel_id</div>
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
          <div class="col-span-3 p-2">
            <input v-model="row.guild_id" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="1500..." />
          </div>
          <div class="col-span-3 p-2">
            <input v-model="row.guild_name" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="VTA test" />
          </div>
          <div class="col-span-3 p-2">
            <input v-model="row.teacher_role_id" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="老師角色 ID" />
          </div>
          <div class="col-span-2 p-2">
            <input v-model="row.teacher_log_channel_id" :disabled="row._pendingDelete" class="w-full border rounded px-2 py-1 text-sm disabled:bg-slate-100 disabled:text-slate-400" placeholder="teacher 頻道 ID" />
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
      teacher_role_id 與 teacher_log_channel_id 可先留空，Bot 會 fallback 到 .env 或同名 teacher 頻道；但多班建議明確填入。
    </p>
  </div>
</template>
