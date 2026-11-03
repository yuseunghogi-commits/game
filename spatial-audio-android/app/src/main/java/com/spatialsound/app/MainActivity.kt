package com.spatialsound.app

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.RadioButton
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
    private lateinit var labelReverb: TextView
    private lateinit var labelWidth: TextView
    private lateinit var headGroup: android.widget.LinearLayout
    private lateinit var layoutGroup: android.widget.LinearLayout
    private lateinit var spinnerEngine: Spinner
    private lateinit var spinnerHpEq: Spinner
    private lateinit var textHpEq: TextView
    private lateinit var spinnerEar: Spinner
    private lateinit var seekSpread: SeekBar
    private lateinit var labelSpread: TextView
    private lateinit var textEngineInfo: TextView
    private lateinit var speakerLayout: SpeakerLayoutView
    private lateinit var seekFront: SeekBar
    private lateinit var seekRearAngle: SeekBar
    private lateinit var seekRearLevel: SeekBar
    private lateinit var labelFront: TextView
    private lateinit var labelRearAngle: TextView
    private lateinit var labelRearLevel: TextView
    private lateinit var labelCenter: TextView
    private lateinit var seekCenter: SeekBar
    private lateinit var labelElev: TextView
    private lateinit var seekElev: SeekBar
    private lateinit var labelHeight: TextView
    private lateinit var seekHeight: SeekBar
    private lateinit var switchHeadPitch: Switch
    private lateinit var spinnerHeadSource: Spinner
    private lateinit var switchHeadInvert: Switch
    private lateinit var textHead: TextView
    private lateinit var seekWidth: SeekBar
    private lateinit var radioStrong: RadioButton
    private lateinit var radioBasic: RadioButton

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
        labelReverb = findViewById(R.id.labelReverb)
        labelWidth = findViewById(R.id.labelWidth)
        headGroup = findViewById(R.id.headGroup)
        layoutGroup = findViewById(R.id.layoutGroup)
        spinnerEngine = findViewById(R.id.spinnerEngine)
        spinnerHpEq = findViewById(R.id.spinnerHpEq)
        textHpEq = findViewById(R.id.textHpEq)
        Strong3DService.ensureAssets(this)
        spinnerHpEq.adapter = darkAdapter(HeadphoneEq.names())
        spinnerEar = findViewById(R.id.spinnerEar)
        seekSpread = findViewById(R.id.seekSpread)
        labelSpread = findViewById(R.id.labelSpread)
        textEngineInfo = findViewById(R.id.textEngineInfo)
        spinnerEngine.adapter = darkAdapter(ENGINE_NAMES)
        spinnerEar.adapter = darkAdapter(HrirSet.EAR_NAMES)
        speakerLayout = findViewById(R.id.speakerLayout)
        seekFront = findViewById(R.id.seekFront)
        seekRearAngle = findViewById(R.id.seekRearAngle)
        seekRearLevel = findViewById(R.id.seekRearLevel)
        labelFront = findViewById(R.id.labelFront)
        labelRearAngle = findViewById(R.id.labelRearAngle)
        labelRearLevel = findViewById(R.id.labelRearLevel)
        labelCenter = findViewById(R.id.labelCenter)
        seekCenter = findViewById(R.id.seekCenter)
        labelElev = findViewById(R.id.labelElev)
        seekElev = findViewById(R.id.seekElev)
        labelHeight = findViewById(R.id.labelHeight)
        seekHeight = findViewById(R.id.seekHeight)
        switchHeadPitch = findViewById(R.id.switchHeadPitch)
        spinnerHeadSource = findViewById(R.id.spinnerHeadSource)
        spinnerHeadSource.adapter = darkAdapter(HEAD_SOURCES)
        switchHeadInvert = findViewById(R.id.switchHeadInvert)
        textHead = findViewById(R.id.textHead)
        seekWidth = findViewById(R.id.seekWidth)
        radioStrong = findViewById(R.id.radioStrong)
        radioBasic = findViewById(R.id.radioBasic)
        if (!SoundController.strongSupported()) {
            radioStrong.isEnabled = false
            radioStrong.text = "강력 3D 모드 — Android 10 이상 필요"
        }

        spinnerPreset.adapter = darkAdapter(SOUND_PRESETS.map { it.name })
        spinnerReverb.adapter = darkAdapter(REVERB_NAMES)

        settings = SpatialSettings.load(this)
        bindUi()
        setupListeners()
        runCatching { rikka.shizuku.Shizuku.addRequestPermissionResultListener(shizukuPermissionListener) }

        // 앱을 다시 열었을 때 설정이 켜져 있으면 서비스도 확실히 살려 둔다.
        if (SoundController.sync(this)) {
            requestStrongStart()
        } else if (needsNotificationPermission()) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        // 빠른 설정 타일에서 강력 모드를 켠 경우
        settings = SpatialSettings.load(this)
        bindUi()
        syncServices()
    }

    private fun needsBluetoothPermission() = Build.VERSION.SDK_INT >= 31 &&
        checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED

    private fun needsNotificationPermission() = Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

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
        runCatching { rikka.shizuku.Shizuku.removeRequestPermissionResultListener(shizukuPermissionListener) }
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
        val strong = settings.strongMode && SoundController.strongSupported()
        radioStrong.isChecked = strong
        radioBasic.isChecked = !strong
        switchGlobal.visibility = if (strong) android.view.View.GONE else android.view.View.VISIBLE
        val wv = if (strong) android.view.View.VISIBLE else android.view.View.GONE
        labelWidth.visibility = wv
        seekWidth.visibility = wv
        seekWidth.progress = settings.width
        headGroup.visibility = wv
        layoutGroup.visibility = wv
        spinnerEngine.setSelection(engineToPos(settings.engineMode))
        spinnerHpEq.setSelection(settings.hpEq.coerceIn(0, HeadphoneEq.profiles.size))
        spinnerEar.setSelection(settings.earSize.coerceIn(0, HrirSet.EAR_NAMES.lastIndex))
        seekSpread.progress = settings.spread - 30
        val loc = settings.engineMode == 2
        labelSpread.visibility = if (loc) android.view.View.VISIBLE else android.view.View.GONE
        seekSpread.visibility = labelSpread.visibility
        seekFront.progress = settings.frontAngle
        seekRearAngle.progress = settings.rearAngle - 90
        seekRearLevel.progress = settings.rearLevel
        speakerLayout.setAngles(settings.frontAngle, settings.rearAngle)
        speakerLayout.rearLevel = settings.rearLevel.toFloat()
        // 공간 모드(실측)는 가운데·옆 스피커까지 7개
        val seven = settings.engineMode == 1
        speakerLayout.centerLevel = if (seven) settings.centerLevel.toFloat() else 0f
        speakerLayout.showSides = settings.engineMode != 0
        seekCenter.progress = settings.centerLevel
        seekElev.progress = settings.frontElev + 20
        seekHeight.progress = settings.heightLevel
        switchHeadPitch.isChecked = settings.headPitch
        // 높이 기능은 실측 엔진(공간·정위)에서만
        val measured = settings.engineMode != 0
        val hv = if (measured) android.view.View.VISIBLE else android.view.View.GONE
        labelElev.visibility = hv; seekElev.visibility = hv; labelHeight.visibility = hv; seekHeight.visibility = hv
        speakerLayout.heightLevel = if (measured) settings.heightLevel.toFloat() else 0f
        labelCenter.visibility = if (seven) android.view.View.VISIBLE else android.view.View.GONE
        seekCenter.visibility = labelCenter.visibility
        spinnerHeadSource.setSelection(settings.headSource.coerceIn(0, HEAD_SOURCES.lastIndex))
        switchHeadInvert.isChecked = settings.headInvert
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
        labelSpace.text = if (settings.strongMode) "방 울림 (벽 반사음): ${settings.spaceEq}%"
        else "공간감 EQ (넓이·공기감): ${settings.spaceEq}%"
        labelWidth.text = "좌우 분리 (반대쪽 귀로 새는 소리 줄이기): ${settings.width}%"
        labelSpread.text = "방향 펼침: 스테레오 끝 = ±${settings.spread}° (클수록 좌우가 넓고 또렷)"
        textEngineInfo.text = ENGINE_INFO[engineToPos(settings.engineMode)]
        textHpEq.text = HeadphoneEq.profiles.getOrNull(settings.hpEq - 1)?.let {
            "측정: ${it.source} · 보정 필터 ${it.filters.size}개 (AutoEq). 헤드폰 앱의 EQ 는 꺼 두세요."
        } ?: "쓰는 헤드폰을 고르면 그 헤드폰 고유의 음색을 평평하게 보정해 3D 단서가 또렷해집니다." 
        labelFront.text = "앞 스피커 각도: ±${settings.frontAngle}° (작을수록 정면)"
        labelRearAngle.text = "뒤 스피커 각도: ±${settings.rearAngle}° (90°=옆, 180°=바로 뒤)"
        labelRearLevel.text = if (settings.engineMode == 0) "뒤 스피커 양: ${settings.rearLevel}% (0이면 전부 앞에서)"
        else "배경음 옆/뒤 비율: ${settings.rearLevel}% (박수·관중·울림을 옆/뒤 스피커로, 0이면 전부 앞에서)"
        labelCenter.text = "가운데 스피커: ${settings.centerLevel}% (보컬·대사를 정면에 단단하게, 0이면 가운데 스피커 없음)"
        labelElev.text = "앞 스피커 높이: " + when {
            settings.frontElev > 0 -> "위 ${settings.frontElev}°"
            settings.frontElev < 0 -> "아래 ${-settings.frontElev}°"
            else -> "귀 높이 (0°)"
        } + " — 영상 볼 때 화면 높이에 맞춰 보세요"
        labelHeight.text = "높이감 (천장 스피커): ${settings.heightLevel}% — 배경음 일부를 머리 위쪽에서"
        labelBass.text = "저음 보강: ${settings.bassStrength / 10}%"
        labelReverb.text = if (settings.strongMode) "잔향 (공간 크기)"
        else "잔향 (공간 크기) — 기본 모드에선 세션을 알려주는 음악앱에서만 적용"
    }

    private fun commit(newSettings: SpatialSettings) {
        settings = newSettings
        settings.save(this)
        updateLabels()
        syncServices()
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
        radioStrong.setOnCheckedChangeListener { _, checked ->
            if (!binding && checked && !settings.strongMode) { commit(settings.copy(strongMode = true)); bindUi() }
        }
        radioBasic.setOnCheckedChangeListener { _, checked ->
            if (!binding && checked && settings.strongMode) { commit(settings.copy(strongMode = false)); bindUi() }
        }
        findViewById<Button>(R.id.buttonDump).setOnClickListener { showDumpHelp() }
        spinnerHeadSource.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                if (binding || pos == settings.headSource) return
                if (pos == 1 && needsBluetoothPermission()) {
                    // 버즈에 직접 연결하려면 '근처 기기' 권한 필요 → 허용되면 그때 선택 반영
                    requestPermissions(arrayOf(Manifest.permission.BLUETOOTH_CONNECT), REQ_BT)
                    return
                }
                commit(settings.copy(headSource = pos))
                if (pos == 2 && !HeadTracker.hasSensor(this@MainActivity)) showHeadHelp()
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        switchHeadInvert.setOnCheckedChangeListener { _, checked ->
            if (!binding) commit(settings.copy(headInvert = checked))
        }
        textHead.setOnClickListener { showHeadHelp() }
        findViewById<Button>(R.id.buttonRecenter).setOnClickListener {
            Strong3DService.instance?.recenterHead()
            Toast.makeText(this, "지금 보는 방향을 정면으로 맞췄습니다", Toast.LENGTH_SHORT).show()
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
                    width = p0.width,
                    frontAngle = p0.front,
                    rearAngle = p0.rearAngle,
                    rearLevel = p0.rearLevel,
                    centerLevel = p0.center,
                    heightLevel = p0.height,
                    frontElev = p0.elev,
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
        spinnerEngine.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                val mode = POS_TO_ENGINE[pos]
                if (binding || mode == settings.engineMode) return
                commit(settings.copy(engineMode = mode))
                bindUi()
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        spinnerHpEq.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                if (binding || pos == settings.hpEq) return
                commit(settings.copy(hpEq = pos))
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        spinnerEar.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(p: AdapterView<*>?, v: android.view.View?, pos: Int, id: Long) {
                if (binding || pos == settings.earSize) return
                commit(settings.copy(earSize = pos))
            }
            override fun onNothingSelected(p: AdapterView<*>?) {}
        }
        seekSpread.setOnSeekBarChangeListener(seekListener { v -> settings.copy(spread = v + 30) })
        findViewById<Button>(R.id.buttonEarTest).setOnClickListener { showEarTest() }
        seekFront.setOnSeekBarChangeListener(seekListener { v ->
            speakerLayout.setAngles(v, settings.rearAngle)
            settings.copy(frontAngle = v, presetIndex = CUSTOM)
        })
        seekRearAngle.setOnSeekBarChangeListener(seekListener { v ->
            speakerLayout.setAngles(settings.frontAngle, v + 90)
            settings.copy(rearAngle = v + 90, presetIndex = CUSTOM)
        })
        seekElev.setOnSeekBarChangeListener(seekListener { v -> settings.copy(frontElev = v - 20, presetIndex = CUSTOM) })
        seekHeight.setOnSeekBarChangeListener(seekListener { v ->
            speakerLayout.heightLevel = v.toFloat()
            settings.copy(heightLevel = v, presetIndex = CUSTOM)
        })
        switchHeadPitch.setOnCheckedChangeListener { _, checked ->
            if (!binding) commit(settings.copy(headPitch = checked))
        }
        seekCenter.setOnSeekBarChangeListener(seekListener { v ->
            speakerLayout.centerLevel = v.toFloat()
            settings.copy(centerLevel = v, presetIndex = CUSTOM)
        })
        seekRearLevel.setOnSeekBarChangeListener(seekListener { v ->
            speakerLayout.rearLevel = v.toFloat()
            settings.copy(rearLevel = v, presetIndex = CUSTOM)
        })
        // 배치도에서 끌기: 움직이는 동안 바로 소리에 반영, 손 떼면 저장
        speakerLayout.onChange = { f, r, done ->
            settings = settings.copy(frontAngle = f, rearAngle = r, presetIndex = CUSTOM)
            updateLabels()
            binding = true
            seekFront.progress = f
            seekRearAngle.progress = r - 90
            binding = false
            if (done) {
                commit(settings)
                binding = true
                spinnerPreset.setSelection(settings.presetIndex)
                binding = false
            } else {
                Strong3DService.instance?.applySettings(settings)
            }
        }
        seekWidth.setOnSeekBarChangeListener(seekListener { v ->
            settings.copy(width = v, presetIndex = CUSTOM)
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

        if (settings.strongMode && SoundController.strongSupported()) {
            renderStrongStatus(s, lines)
            textStatus.text = lines.joinToString("\n")
            return
        }
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

    private fun renderHead(s: EngineState.Snapshot) {
        speakerLayout.headYaw = s.headYaw.toFloat()
        textHead.text = when {
            settings.headSource == 0 -> "꺼짐 — 갤럭시 버즈 등 머리 센서가 있는 이어폰을 고르면 고개를 돌려도 소리가 제자리에 머뭅니다 (헤드폰 Bose QC 는 센서 없음)"
            settings.headSource == 2 && Build.VERSION.SDK_INT < 33 -> "⚠️ 표준 센서 방식은 Android 13 이상에서만 지원됩니다"
            !s.strongRunning -> "강력 3D 모드가 켜지면 시작됩니다"
            s.headSensor.isNotEmpty() -> {
                val yaw = s.headYaw.toInt()
                val dir = when { yaw > 3 -> "오른쪽 ${yaw}°"; yaw < -3 -> "왼쪽 ${-yaw}°"; else -> "정면" }
                val pitch = s.headPitch.toInt()
                val up = when { pitch > 3 -> " · 위 ${pitch}°"; pitch < -3 -> " · 아래 ${-pitch}°"; else -> "" }
                "✅ ${s.headSensor}\n현재 머리 방향: $dir$up"
            }
            else -> "⏳ ${s.headInfo.ifBlank { "연결 준비 중…" }}\n(여기를 누르면 안내)"
        }
    }

    /** 귀 맞춤 테스트: 단계별로 들어 보고 앞/뒤가 가장 확실한 단계 선택 */
    private fun showEarTest() {
        val base = Strong3DService.ensureHrir(this) ?: run {
            Toast.makeText(this, "실측 데이터를 불러오지 못했습니다", Toast.LENGTH_SHORT).show(); return
        }
        var chosen = settings.earSize
        val items = HrirSet.EAR_NAMES.map { "▶ $it" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle("👂 귀 맞춤 테스트")
            .setSingleChoiceItems(items, chosen) { _, which ->
                chosen = which
                EarFitTest.play(base, which)
            }
            .setMessage(null)
            .setPositiveButton("이 단계로 선택") { _, _ ->
                EarFitTest.stop()
                commit(settings.copy(earSize = chosen))
                bindUi()
                Toast.makeText(this, "귀 맞춤: ${HrirSet.EAR_NAMES[chosen]}", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("닫기") { _, _ -> EarFitTest.stop() }
            .show()
        Toast.makeText(
            this,
            "헤드폰을 쓰고 각 단계를 눌러 들어 보세요.\n소리 순서: ${EarFitTest.SEQUENCE_TEXT}\n앞/뒤가 가장 확실히 구분되는 단계를 고르세요.",
            Toast.LENGTH_LONG,
        ).show()
    }

    private fun showHeadHelp() {
        AlertDialog.Builder(this)
            .setTitle("헤드 트래킹 안내")
            .setMessage(
                "고개를 돌려도 소리가 공간의 같은 자리에 머물러, 진짜 스피커 앞에 있는 느낌을 줍니다. " +
                "앞/뒤 구분과 '머리 바깥에서 들리는 느낌'이 가장 크게 좋아지는 기능입니다.\n\n" +
                "■ 갤럭시 버즈 (블루투스 직접 연결)\n" +
                "버즈의 360 오디오용 센서를 앱이 직접 읽습니다. Buds+ 이후 모델(Buds Pro·Buds2·Buds2 Pro·Buds3 계열)용이며, " +
                "공개 프로젝트에서 Buds Pro·Buds2 로 확인된 방식입니다.\n" +
                "• 버즈를 폰에 연결하고 귀에 착용하세요. 착용하는 순간의 방향이 정면이 됩니다.\n" +
                "• '버즈에 연결하지 못했습니다'가 계속 뜨면: 삼성 Galaxy Wearable(버즈 플러그인)이 같은 연결을 쓰고 있을 수 있습니다. " +
                "설정 → 애플리케이션 → Galaxy Buds… Plugin → 강제 중지 후 다시 시도하세요.\n" +
                "• 삼성 '360 오디오'는 꺼 두세요 (소리가 두 번 처리될 수 있음).\n" +
                "• 방향이 반대로 느껴지면 '방향 반대로'를 켜세요.\n\n" +
                "■ 이어폰 표준 센서 (Android 13+)\n" +
                "Android 표준 머리 센서를 공개하는 이어폰(픽셀 버즈 프로 등)용입니다.\n\n" +
                "헤드폰(Bose QC 등)은 머리 센서가 없어서 헤드 트래킹을 쓸 수 없습니다."
            )
            .setPositiveButton("확인", null)
            .show()
    }

    private fun renderStrongStatus(s: EngineState.Snapshot, lines: MutableList<String>) {
        renderHead(s)
        val dump = SessionMuter.hasDumpPermission(this)
        lines += if (dump) "🔑 원래 소리 음소거 권한: 있음" else "🔑 원래 소리 음소거 권한: 없음 → 위 '🔑 강력 모드 권한 설정' 버튼"
        when {
            !settings.enabled -> lines += "⏸ 꺼져 있음"
            !s.strongRunning -> lines += "⏳ 시작 대기 중 (오디오 공유를 허용해야 시작됨)"
            settings.headphonesOnly && !s.headphones -> lines += "⏸ 헤드폰 연결 대기 중 (소리는 그대로 통과)"
            else -> lines += "✅ 강력 3D 적용 중 — 유튜브 등 모든 앱"
        }
        if (s.strongRunning && s.mutedApps.isNotEmpty()) {
            lines += "처리 중인 앱: " + s.mutedApps.joinToString { appLabel(it) }
        }
        if (s.strongRunning && s.restrictedApps.isNotEmpty()) {
            lines += "⚠️ 캡처를 막은 앱(원음 그대로 재생): " + s.restrictedApps.take(4).joinToString { appLabel(it) }
        }
    }

    private fun appLabel(pkg: String): String = runCatching {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    }.getOrDefault(pkg)

    // --- 서비스 연결 / 강력 모드 시작 ----------------------------------------

    private fun syncServices() {
        if (SoundController.sync(this)) requestStrongStart()
    }

    private fun requestStrongStart() {
        if (pendingProjection) return
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
            if (needsNotificationPermission()) perms += Manifest.permission.POST_NOTIFICATIONS
            requestPermissions(perms.toTypedArray(), REQ_RECORD)
            return
        }
        if (!SessionMuter.hasDumpPermission(this)) {
            // 권한 없이 시작하면 원래 소리 + 처리된 소리가 겹쳐서 메아리처럼 들린다.
            commit(settings.copy(enabled = false))
            bindUi()
            showDumpHelp()
            return
        }
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= 34) {
            // '앱 하나만' 공유하면 다른 앱 소리를 못 가져오므로 전체 화면 공유로 고정
            mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else mpm.createScreenCaptureIntent()
        pendingProjection = true
        Toast.makeText(this, "소리를 가져오려면 '시작'을 눌러 주세요 (화면은 녹화되지 않습니다)", Toast.LENGTH_LONG).show()
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQ_PROJECTION)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PROJECTION) return
        pendingProjection = false
        if (resultCode == RESULT_OK && data != null) {
            Strong3DService.start(this, resultCode, data)
        } else {
            Toast.makeText(this, "허용하지 않아서 강력 3D 모드를 켜지 못했습니다", Toast.LENGTH_SHORT).show()
            commit(settings.copy(enabled = false))
            bindUi()
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_BT) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
                commit(settings.copy(headSource = 1))
            } else {
                Toast.makeText(this, "버즈에 연결하려면 '근처 기기' 권한이 필요합니다", Toast.LENGTH_LONG).show()
            }
            bindUi()
            return
        }
        if (requestCode != REQ_RECORD) return
        val idx = permissions.indexOf(Manifest.permission.RECORD_AUDIO)
        if (idx >= 0 && grantResults.getOrNull(idx) == PackageManager.PERMISSION_GRANTED) {
            requestStrongStart()
        } else {
            Toast.makeText(this, "다른 앱 소리를 가져오려면 '오디오 녹음' 권한이 필요합니다", Toast.LENGTH_LONG).show()
            commit(settings.copy(enabled = false))
            bindUi()
        }
    }

    /** 강력 모드 권한 설정: Shizuku(PC 없이) 단계별 안내 + PC 명령어 대안 */
    private fun showDumpHelp() {
        if (SessionMuter.hasDumpPermission(this)) {
            AlertDialog.Builder(this)
                .setTitle("설정 완료 ✅")
                .setMessage("원래 소리 음소거 권한이 이미 있습니다.\n강력 3D 모드를 선택하고 '3D 음향 켜기'를 누르세요.")
                .setPositiveButton("확인", null)
                .show()
            return
        }
        val st = ShizukuHelper.state(this)
        val (step, msg) = when (st) {
            ShizukuHelper.State.NOT_INSTALLED -> "1/4 단계: Shizuku 설치" to
                "PC 없이 권한을 받으려면 무료 앱 'Shizuku'가 필요합니다.\n\n" +
                "아래 [Shizuku 설치]를 눌러 설치한 뒤, 이 앱으로 돌아와 이 버튼을 다시 누르세요."
            ShizukuHelper.State.NOT_RUNNING -> "2/4 단계: Shizuku 실행 (처음 한 번 페어링)" to
                "① 개발자 옵션 켜기 (이미 했으면 건너뛰기)\n" +
                "   설정 → 휴대전화 정보 → 소프트웨어 정보 → '빌드번호'를 7번 연속 탭\n\n" +
                "② Wi-Fi에 연결된 상태여야 합니다\n\n" +
                "③ Shizuku 앱 열기 → '무선 디버깅을 통해 시작' 칸의 [페어링] 누르기\n" +
                "   → 알림 허용을 물으면 허용\n\n" +
                "④ [개발자 옵션 열기] → '무선 디버깅' 켜기 → '무선 디버깅' 글자를 눌러 들어가기\n" +
                "   → '페어링 코드로 기기 페어링' 누르기 → 6자리 숫자가 보임\n\n" +
                "⑤ 그 화면 그대로 상단바를 내려 Shizuku 알림의 [페어링 코드 입력]에 6자리 입력\n" +
                "   → '페어링 성공' 알림이 뜸\n\n" +
                "⑥ Shizuku 앱으로 돌아가 '무선 디버깅을 통해 시작'의 [시작] 누르기\n" +
                "   → 'Shizuku가 실행 중입니다' 가 보이면 성공\n\n" +
                "⑦ 이 앱으로 돌아와 이 버튼을 다시 누르기\n\n" +
                "※ 폰을 재부팅하면 Shizuku만 ⑥번처럼 [시작]을 다시 누르면 됩니다 (페어링은 1번만)."
            ShizukuHelper.State.NO_PERMISSION -> "3/4 단계: Shizuku 사용 허용" to
                "Shizuku가 실행 중입니다 👍\n\n" +
                "[허용 요청]을 누르면 Shizuku 창이 뜹니다. '항상 허용'(또는 '허용')을 누르세요.\n" +
                "그러면 자동으로 권한을 받습니다."
            ShizukuHelper.State.READY -> "4/4 단계: 권한 받기" to
                "준비 완료! [권한 받기]를 누르면 바로 설정됩니다."
        }
        val b = AlertDialog.Builder(this)
            .setTitle(step)
            .setMessage(msg)
            .setNeutralButton("PC로 하기") { _, _ -> showPcHelp() }
            .setNegativeButton("닫기", null)
        when (st) {
            ShizukuHelper.State.NOT_INSTALLED ->
                b.setPositiveButton("Shizuku 설치") { _, _ -> ShizukuHelper.openStore(this) }
            ShizukuHelper.State.NOT_RUNNING -> {
                b.setPositiveButton("Shizuku 열기") { _, _ -> ShizukuHelper.openShizuku(this) }
                b.setNeutralButton("개발자 옵션 열기") { _, _ -> ShizukuHelper.openDeveloperOptions(this) }
            }
            ShizukuHelper.State.NO_PERMISSION ->
                b.setPositiveButton("허용 요청") { _, _ -> ShizukuHelper.requestPermission(REQ_SHIZUKU) }
            ShizukuHelper.State.READY ->
                b.setPositiveButton("권한 받기") { _, _ -> grantViaShizuku() }
        }
        b.show()
    }

    private val shizukuPermissionListener =
        rikka.shizuku.Shizuku.OnRequestPermissionResultListener { requestCode, grantResult ->
            if (requestCode != REQ_SHIZUKU) return@OnRequestPermissionResultListener
            runOnUiThread {
                if (grantResult == PackageManager.PERMISSION_GRANTED) grantViaShizuku()
                else Toast.makeText(this, "Shizuku 허용이 거부되었습니다", Toast.LENGTH_SHORT).show()
            }
        }

    private fun grantViaShizuku() {
        Toast.makeText(this, "권한을 받는 중…", Toast.LENGTH_SHORT).show()
        Thread {
            val ok = ShizukuHelper.grantDump(this)
            runOnUiThread {
                if (ok) {
                    AlertDialog.Builder(this)
                        .setTitle("설정 완료 ✅")
                        .setMessage("이제 강력 3D 모드를 쓸 수 있습니다.\n'3D 음향 켜기'를 누르고, 소리 공유 창에서 [시작]을 누르세요.\n\n권한은 앱을 지우기 전까지 유지됩니다 (재부팅해도 OK).")
                        .setPositiveButton("확인", null)
                        .show()
                    renderStatus(EngineState.snapshot)
                } else {
                    Toast.makeText(this, "권한 받기 실패 — 'PC로 하기' 방법을 써 주세요", Toast.LENGTH_LONG).show()
                }
            }
        }.start()
    }

    private fun showPcHelp() {
        val msg = buildString {
            append("1) 설정 → 휴대전화 정보 → 소프트웨어 정보 → '빌드번호' 7번 누르기 (개발자 옵션 켜기)\n")
            append("2) 설정 → 개발자 옵션 → 'USB 디버깅' 켜기\n")
            append("3) PC에 USB로 연결 후 PC 명령창에서:\n\n")
            append(SessionMuter.GRANT_COMMAND)
            append("\n\n4) 이 앱을 완전히 닫았다가 다시 열기")
        }
        AlertDialog.Builder(this)
            .setTitle("PC로 권한 주기")
            .setMessage(msg)
            .setPositiveButton("명령어 복사") { _, _ ->
                val cm = getSystemService(ClipboardManager::class.java)
                cm.setPrimaryClip(ClipData.newPlainText("adb", SessionMuter.GRANT_COMMAND))
                Toast.makeText(this, "복사했습니다", Toast.LENGTH_SHORT).show()
            }
            .setNegativeButton("닫기", null)
            .show()
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

    private var pendingProjection = false

    companion object {
        private val CUSTOM = SOUND_PRESETS.lastIndex

        /** 화면 순서: 공간(실측), 정위, 기본 */
        private val ENGINE_NAMES = listOf(
            "🏠 공간 모드 (실측 HRTF) — 방 안 스피커처럼, 추천",
            "🎯 정위 모드 — 어디서 소리 나는지 또렷하게 (게임·영화)",
            "기본 모드 (이전 엔진, 계산 모델)",
        )
        private val ENGINE_INFO = listOf(
            "실제 사람 머리 모양 더미헤드(KEMAR)에서 측정한 귀 특성으로 가상 스피커를 들려줍니다.",
            "소리를 주파수별로 쪼개 스테레오 위치에 맞는 정확한 방향에 하나씩 놓습니다. 배경음은 옆/뒤로 분리. 반사음·잔향은 약하게.",
            "v1.1 까지의 엔진 (구 모양 머리 계산 모델).",
        )
        private val POS_TO_ENGINE = intArrayOf(1, 2, 0)
        private fun engineToPos(mode: Int) = POS_TO_ENGINE.indexOf(mode).coerceAtLeast(0)

        private const val REQ_PROJECTION = 10
        private const val REQ_RECORD = 11
        private const val REQ_SHIZUKU = 12
        private const val REQ_BT = 13
        /** 헤드 트래킹 장치 (SpatialSettings.headSource 순서) */
        private val HEAD_SOURCES = listOf(
            "끄기",
            "갤럭시 버즈 (블루투스로 센서 직접 연결)",
            "이어폰 표준 머리 센서 (Android 13+, 픽셀 버즈 등)",
        )
        const val EXTRA_START = "start"
    }
}
