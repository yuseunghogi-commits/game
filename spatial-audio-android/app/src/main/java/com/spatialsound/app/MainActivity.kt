package com.spatialsound.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var switchEnabled: Switch
    private lateinit var switchGlobal: Switch
    private lateinit var switchHeadphonesOnly: Switch
    private lateinit var spinnerPreset: Spinner
    private lateinit var spinnerReverb: Spinner
    private lateinit var seekVirtualizer: SeekBar
    private lateinit var seekSpace: SeekBar
    private lateinit var seekBass: SeekBar
    private lateinit var labelVirtualizer: TextView
    private lateinit var labelSpace: TextView
    private lateinit var labelBass: TextView
    private lateinit var textStatus: TextView

    private var settings = SpatialSettings()
    /** 코드로 위젯 값을 바꾸는 동안 리스너가 반응하지 않도록 */
    private var binding = false

    private val stateListener: (EngineState.Snapshot) -> Unit = { renderStatus(it) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        switchEnabled = findViewById(R.id.switchEnabled)
        switchGlobal = findViewById(R.id.switchGlobal)
        switchHeadphonesOnly = findViewById(R.id.switchHeadphonesOnly)
        spinnerPreset = findViewById(R.id.spinnerPreset)
        spinnerReverb = findViewById(R.id.spinnerReverb)
        seekVirtualizer = findViewById(R.id.seekVirtualizer)
        seekSpace = findViewById(R.id.seekSpace)
        seekBass = findViewById(R.id.seekBass)
        labelVirtualizer = findViewById(R.id.labelVirtualizer)
        labelSpace = findViewById(R.id.labelSpace)
        labelBass = findViewById(R.id.labelBass)
        textStatus = findViewById(R.id.textStatus)

        spinnerPreset.adapter = darkAdapter(SOUND_PRESETS.map { it.name })
        spinnerReverb.adapter = darkAdapter(REVERB_NAMES)

        settings = SpatialSettings.load(this)
        bindUi()
        setupListeners()

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        // 앱을 다시 열었을 때 설정이 켜져 있으면 서비스도 확실히 살려 둔다.
        SpatialAudioService.sync(this)
    }

    override fun onStart() {
        super.onStart()
        EngineState.addListener(stateListener)
    }

    override fun onResume() {
        super.onResume()
        // 알림/타일에서 끈 경우 반영
        settings = SpatialSettings.load(this)
        bindUi()
    }

    override fun onStop() {
        EngineState.removeListener(stateListener)
        super.onStop()
    }

    override fun onDestroy() {
        TestSound.stop()
        super.onDestroy()
    }

    private fun darkAdapter(items: List<String>) =
        ArrayAdapter(this, android.R.layout.simple_spinner_item, items).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }

    private fun bindUi() {
        binding = true
        switchEnabled.isChecked = settings.enabled
        switchGlobal.isChecked = settings.globalMode
        switchHeadphonesOnly.isChecked = settings.headphonesOnly
        spinnerPreset.setSelection(settings.presetIndex.coerceIn(0, SOUND_PRESETS.lastIndex))
        spinnerReverb.setSelection(settings.reverbPreset.coerceIn(0, REVERB_NAMES.lastIndex))
        seekVirtualizer.progress = settings.virtualizerStrength
        seekSpace.progress = settings.spaceEq
        seekBass.progress = settings.bassStrength
        updateLabels()
        binding = false
        renderStatus(EngineState.snapshot)
    }

    private fun updateLabels() {
        labelVirtualizer.text = "3D 서라운드 강도: ${settings.virtualizerStrength / 10}%"
        labelSpace.text = "공간감 EQ (넓이·공기감): ${settings.spaceEq}%"
        labelBass.text = "저음 보강: ${settings.bassStrength / 10}%"
    }

    private fun commit(newSettings: SpatialSettings) {
        settings = newSettings
        settings.save(this)
        updateLabels()
        SpatialAudioService.sync(this)
        SpatialTileService.requestUpdate(this)
        renderStatus(EngineState.snapshot)
    }

    private fun setupListeners() {
        switchEnabled.setOnCheckedChangeListener { _, checked ->
            if (!binding) commit(settings.copy(enabled = checked))
        }
        switchGlobal.setOnCheckedChangeListener { _, checked ->
            if (!binding) commit(settings.copy(globalMode = checked))
        }
        switchHeadphonesOnly.setOnCheckedChangeListener { _, checked ->
            if (!binding) commit(settings.copy(headphonesOnly = checked))
        }

        spinnerPreset.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                if (binding || pos == settings.presetIndex) return
                val p0 = SOUND_PRESETS[pos]
                val next = if (p0.virtualizer < 0) settings.copy(presetIndex = pos)
                else settings.copy(
                    presetIndex = pos,
                    virtualizerStrength = p0.virtualizer,
                    bassStrength = p0.bass,
                    spaceEq = p0.spaceEq,
                    reverbPreset = p0.reverb.toInt(),
                )
                commit(next)
                bindUi()
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }

        spinnerReverb.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                if (binding || pos == settings.reverbPreset) return
                commit(settings.copy(reverbPreset = pos, presetIndex = CUSTOM))
                bindUi()
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }

        seekVirtualizer.setOnSeekBarChangeListener(seekListener { v ->
            settings.copy(virtualizerStrength = v, presetIndex = CUSTOM)
        })
        seekSpace.setOnSeekBarChangeListener(seekListener { v ->
            settings.copy(spaceEq = v, presetIndex = CUSTOM)
        })
        seekBass.setOnSeekBarChangeListener(seekListener { v ->
            settings.copy(bassStrength = v, presetIndex = CUSTOM)
        })

        findViewById<Button>(R.id.buttonTest).setOnClickListener {
            TestSound.play()
            Toast.makeText(this, "헤드폰으로 들어보세요: 앞 → 오른쪽 → 뒤 → 왼쪽", Toast.LENGTH_LONG).show()
        }
        findViewById<Button>(R.id.buttonSystem).setOnClickListener { openSystemSpatialSettings() }
    }

    private fun seekListener(update: (Int) -> SpatialSettings) = object : SeekBar.OnSeekBarChangeListener {
        override fun onProgressChanged(sb: SeekBar?, value: Int, fromUser: Boolean) {
            if (!fromUser || binding) return
            settings = update(value)
            updateLabels()
        }
        override fun onStartTrackingTouch(sb: SeekBar?) {}
        override fun onStopTrackingTouch(sb: SeekBar?) {
            commit(settings)
            binding = true
            spinnerPreset.setSelection(settings.presetIndex)
            binding = false
        }
    }

    private fun renderStatus(s: EngineState.Snapshot) {
        val lines = mutableListOf<String>()
        lines += if (s.headphones) "🎧 헤드폰 연결됨: ${s.headphoneName.ifBlank { "알 수 없음" }}"
        else "🔈 헤드폰이 연결되지 않음"

        when {
            !settings.enabled -> lines += "⏸ 꺼져 있음"
            !s.running -> lines += "⏳ 시작하는 중…"
            settings.headphonesOnly && !s.headphones -> lines += "⏸ 대기 중 (헤드폰을 연결하면 자동으로 켜짐)"
            settings.globalMode && s.globalOk && s.globalHasControl ->
                lines += "✅ 모든 앱(유튜브 등)에 3D 음향 적용 중"
            settings.globalMode && s.globalOk && !s.globalHasControl ->
                lines += "⚠️ 다른 이퀄라이저 앱이 사운드를 제어 중 — 그 앱을 꺼 주세요"
            settings.globalMode && !s.globalOk ->
                lines += "⚠️ 이 기기는 전체 출력 효과를 막고 있음 — 세션을 알려주는 음악앱에만 적용됩니다"
            else -> lines += "✅ 세션을 알려주는 음악앱에만 적용 중"
        }
        if (settings.enabled && s.globalOk && !s.globalVirtualizerOk) {
            lines += "ℹ️ 기기가 가상 서라운드를 지원하지 않아 EQ/저음만 적용됩니다"
        }
        if (s.sessions.isNotEmpty()) {
            lines += "앱별 연결: " + s.sessions.values.distinct().joinToString()
        }
        systemSpatializerInfo()?.let { lines += it }
        textStatus.text = lines.joinToString("\n")
    }

    /** Android 12L+ 기기 내장 공간 음향(Spatializer) 상태 안내 */
    private fun systemSpatializerInfo(): String? {
        if (Build.VERSION.SDK_INT < 32) return null
        val am = getSystemService(AUDIO_SERVICE) as AudioManager
        val sp = am.spatializer
        if (sp.immersiveAudioLevel == android.media.Spatializer.SPATIALIZER_IMMERSIVE_LEVEL_NONE) return null
        return when {
            sp.isEnabled && sp.isAvailable ->
                "ℹ️ 기기 내장 공간 음향도 켜져 있음 — 이중 처리로 소리가 뭉개지면 둘 중 하나를 끄세요"
            else -> "ℹ️ 이 기기는 내장 공간 음향도 지원합니다 (아래 버튼)"
        }
    }

    private fun openSystemSpatialSettings() {
        val candidates = listOf(
            Intent(Settings.ACTION_BLUETOOTH_SETTINGS),
            Intent(Settings.ACTION_SOUND_SETTINGS),
        )
        for (i in candidates) {
            try {
                startActivity(i)
                Toast.makeText(this, "연결된 헤드폰 설정에서 '공간 음향'을 찾아보세요", Toast.LENGTH_LONG).show()
                return
            } catch (e: Exception) {
            }
        }
    }

    companion object {
        private val CUSTOM = SOUND_PRESETS.lastIndex
    }
}
