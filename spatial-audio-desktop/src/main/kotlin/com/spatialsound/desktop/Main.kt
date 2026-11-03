package com.spatialsound.desktop

import com.spatialsound.app.REVERB_NAMES
import com.spatialsound.app.SOUND_PRESETS
import com.spatialsound.app.SpatialSettings
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.Font
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import java.util.prefs.Preferences
import javax.sound.sampled.Mixer
import javax.swing.BorderFactory
import javax.swing.DefaultListCellRenderer
import javax.swing.JButton
import javax.swing.JCheckBox
import javax.swing.JComboBox
import javax.swing.JFrame
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JOptionPane
import javax.swing.JPanel
import javax.swing.JSlider
import javax.swing.SwingUtilities
import javax.swing.UIManager
import javax.swing.WindowConstants

/** 노트북/PC용 3D 사운드. 안드로이드 앱의 강력 3D 엔진과 같은 소리. */
fun main() {
    runCatching { UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName()) }
    // 실측 HRIR (jar 안의 리소스)
    runCatching {
        MainWindow::class.java.getResourceAsStream("/hrir_kemar.bin")?.use {
            com.spatialsound.app.BinauralProcessor.hrirBase = com.spatialsound.app.HrirSet.load(it)
        }
    }
    runCatching {
        MainWindow::class.java.getResourceAsStream("/headphone_eq.txt")?.use {
            com.spatialsound.app.HeadphoneEq.profiles = com.spatialsound.app.HeadphoneEq.parse(it)
        }
    }
    SwingUtilities.invokeLater { MainWindow().isVisible = true }
}

class MainWindow : JFrame("3D 사운드 (PC)") {
    private val prefs = Preferences.userRoot().node("spatial-sound-desktop")
    private var engine: AudioEngine? = null
    private var settings = loadSettings()
    private var applyingPreset = false

    private val font = pickFont()
    private val inputBox = JComboBox<Mixer.Info>()
    private val outputBox = JComboBox<Mixer.Info>()
    private val startBtn = JButton("▶ 시작")
    private val enable3d = JCheckBox("3D 효과 켜기 (끄면 원음 그대로 비교)", true)
    private val presetBox = JComboBox((SOUND_PRESETS.map { it.name } + "사용자 설정").toTypedArray())
    private val reverbBox = JComboBox(REVERB_NAMES.toTypedArray())
    private val engineBox = JComboBox(arrayOf("🏠 공간 모드 (실측 HRTF) — 추천", "🎯 정위 모드 — 방향 또렷 (게임·영화)", "기본 모드 (이전 엔진)"))
    private val earBox = JComboBox(com.spatialsound.app.HrirSet.EAR_NAMES.toTypedArray())
    private val hpEqBox = JComboBox(com.spatialsound.app.HeadphoneEq.names().toTypedArray())
    private val hpEqInfo = JLabel(" ")
    private val sSpread = slider(30, 120, settings.spread)
    private val lSpread = JLabel()
    private val sStrength = slider(0, 1000, settings.virtualizerStrength)
    private val sWidth = slider(0, 100, settings.width)
    private val sRoom = slider(0, 100, settings.spaceEq)
    private val sBass = slider(0, 1000, settings.bassStrength)
    private val sFront = slider(0, 90, settings.frontAngle)
    private val sRearAngle = slider(90, 180, settings.rearAngle)
    private val sRearLevel = slider(0, 100, settings.rearLevel)
    private val sCenter = slider(0, 100, settings.centerLevel)
    private val lCenter = JLabel()
    private val lFront = JLabel(); private val lRearAngle = JLabel(); private val lRearLevel = JLabel()
    private val lStrength = JLabel(); private val lWidth = JLabel(); private val lRoom = JLabel(); private val lBass = JLabel()
    private val status = JLabel(" ")

    init {
        defaultCloseOperation = WindowConstants.EXIT_ON_CLOSE
        val root = JPanel(GridBagLayout())
        root.border = BorderFactory.createEmptyBorder(14, 16, 14, 16)
        val c = GridBagConstraints().apply {
            gridx = 0; gridy = 0; weightx = 1.0; fill = GridBagConstraints.HORIZONTAL; insets = Insets(3, 0, 3, 0)
        }
        fun row(comp: java.awt.Component) { root.add(comp, c); c.gridy++ }
        fun title(t: String) = JLabel(t).apply {
            this.font = this@MainWindow.font.deriveFont(Font.BOLD, 15f); foreground = Color(0x6A, 0x4C, 0xE0)
            border = BorderFactory.createEmptyBorder(10, 0, 2, 0)
        }

        row(JLabel("3D 사운드").apply { this.font = this@MainWindow.font.deriveFont(Font.BOLD, 22f) })
        row(JLabel("<html>유튜브·게임·영화 소리를 헤드폰용 3D 입체 음향으로</html>"))

        row(title("① 장치"))
        row(JLabel("입력 (가상 케이블: 'CABLE Output' 선택)"))
        row(inputBox)
        row(JLabel("출력 (내 헤드폰/이어폰 선택 — CABLE 말고!)"))
        row(outputBox)
        val devRow = JPanel(BorderLayout(8, 0))
        devRow.add(JButton("장치 새로고침").apply { addActionListener { loadDevices() } }, BorderLayout.WEST)
        devRow.add(JButton("처음 설정 방법").apply { addActionListener { showHelp() } }, BorderLayout.EAST)
        row(devRow)
        row(JLabel("🎧 헤드폰 보정 (쓰는 헤드폰을 고르세요 — 헤드폰 앱 EQ 는 끄기)"))
        row(hpEqBox)
        row(hpEqInfo)
        row(startBtn.apply { this.font = this@MainWindow.font.deriveFont(Font.BOLD, 16f); preferredSize = Dimension(10, 42) })
        row(enable3d)
        row(status)

        row(title("② 3D 엔진"))
        row(engineBox)
        row(lSpread); row(sSpread)
        row(JLabel("👂 귀 맞춤 (앞/뒤가 헷갈리면 단계를 바꿔 보세요)")); row(earBox)

        row(title("③ 소리 조절"))
        row(JLabel("프리셋")); row(presetBox)
        row(lStrength); row(sStrength)
        row(lFront); row(sFront)
        row(lRearAngle); row(sRearAngle)
        row(lRearLevel); row(sRearLevel)
        row(lCenter); row(sCenter)
        row(lWidth); row(sWidth)
        row(lRoom); row(sRoom)
        row(JLabel("잔향 (방 크기)")); row(reverbBox)
        row(lBass); row(sBass)

        contentPane = javax.swing.JScrollPane(root).apply {
            border = null; verticalScrollBar.unitIncrement = 16
            horizontalScrollBarPolicy = javax.swing.ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER
        }
        applyFont(root)
        reverbBox.selectedIndex = settings.reverbPreset.coerceIn(0, REVERB_NAMES.lastIndex)
        presetBox.selectedIndex = prefs.getInt("preset", 0).coerceIn(0, SOUND_PRESETS.size)
        updateLabels()
        loadDevices()

        startBtn.addActionListener { if (engine?.isRunning == true) stopEngine() else startEngine() }
        enable3d.addActionListener { engine?.bypass = !enable3d.isSelected }
        presetBox.addActionListener {
            val i = presetBox.selectedIndex
            prefs.putInt("preset", i)
            if (i < SOUND_PRESETS.size) {
                applyingPreset = true
                val p = SOUND_PRESETS[i].s
                sStrength.value = p.virtualizerStrength; sWidth.value = p.width; sRoom.value = p.spaceEq
                sBass.value = p.bassStrength; reverbBox.selectedIndex = p.reverbPreset
                sFront.value = p.frontAngle; sRearAngle.value = p.rearAngle; sRearLevel.value = p.rearLevel
                sCenter.value = p.centerLevel
                applyingPreset = false
                changed()
            }
        }
        listOf(sStrength, sWidth, sRoom, sBass, sFront, sRearAngle, sRearLevel, sCenter).forEach { s -> s.addChangeListener { changed() } }
        reverbBox.addActionListener { changed() }
        engineBox.selectedIndex = intArrayOf(1, 2, 0).indexOf(settings.engineMode).coerceAtLeast(0)
        earBox.selectedIndex = settings.earSize.coerceIn(0, 4)
        engineBox.addActionListener { changed() }
        hpEqBox.selectedIndex = settings.hpEq.coerceIn(0, hpEqBox.itemCount - 1)
        hpEqBox.addActionListener { changed() }
        earBox.addActionListener { changed() }
        sSpread.addChangeListener { changed() }
        lSpread.isVisible = settings.engineMode == 2; sSpread.isVisible = lSpread.isVisible
        lCenter.isVisible = settings.engineMode == 1; sCenter.isVisible = lCenter.isVisible
        updateLabels()

        pack()
        val screenH = java.awt.Toolkit.getDefaultToolkit().screenSize.height
        size = Dimension(width + 24, minOf(height, (screenH * 0.85).toInt()))
        minimumSize = Dimension(460, 400)
        setLocationRelativeTo(null)
    }

    private fun slider(min: Int, max: Int, v: Int) = JSlider(min, max, v)

    private fun changed() {
        settings = SpatialSettings(
            virtualizerStrength = sStrength.value, bassStrength = sBass.value, spaceEq = sRoom.value,
            reverbPreset = reverbBox.selectedIndex, width = sWidth.value,
            frontAngle = sFront.value, rearAngle = sRearAngle.value, rearLevel = sRearLevel.value,
            engineMode = intArrayOf(1, 2, 0)[engineBox.selectedIndex.coerceAtLeast(0)],
            spread = sSpread.value, earSize = earBox.selectedIndex.coerceAtLeast(0),
            hpEq = hpEqBox.selectedIndex.coerceAtLeast(0),
            centerLevel = sCenter.value,
        )
        lCenter.isVisible = settings.engineMode == 1; sCenter.isVisible = lCenter.isVisible
        lSpread.isVisible = settings.engineMode == 2; sSpread.isVisible = lSpread.isVisible
        val soundOnly = settings.copy(engineMode = 1, spread = 90, earSize = 2, hpEq = 0)
        if (!applyingPreset && presetBox.selectedIndex < SOUND_PRESETS.size &&
            SOUND_PRESETS[presetBox.selectedIndex].s != soundOnly
        ) {
            presetBox.selectedIndex = SOUND_PRESETS.size // 사용자 설정
        }
        updateLabels()
        saveSettings()
        engine?.update(settings)
    }

    private fun updateLabels() {
        lStrength.text = "3D 강도: ${sStrength.value / 10}%"
        lSpread.text = "방향 펼침: 스테레오 끝 = ±${sSpread.value}°"
        hpEqInfo.text = com.spatialsound.app.HeadphoneEq.profiles.getOrNull(hpEqBox.selectedIndex - 1)
            ?.let { "측정: ${it.source} · 필터 ${it.filters.size}개 (AutoEq)" } ?: " "
        lWidth.text = "좌우 분리 (반대쪽 귀로 새는 소리 줄이기): ${sWidth.value}%"
        lFront.text = "앞 스피커 각도: ±${sFront.value}° (작을수록 정면)"
        lRearAngle.text = "뒤 스피커 각도: ±${sRearAngle.value}° (90°=옆, 180°=바로 뒤)"
        val classic = engineBox.selectedIndex == 2
        lRearLevel.text = if (classic) "뒤 스피커 양: ${sRearLevel.value}% (0이면 전부 앞에서)"
        else "배경음 옆/뒤 비율: ${sRearLevel.value}% (박수·관중·울림을 옆/뒤로)"
        lCenter.text = "가운데 스피커: ${sCenter.value}% (보컬·대사를 정면에)"
        lRoom.text = "방 울림 (벽 반사음): ${sRoom.value}%"
        lBass.text = "저음 보강: ${sBass.value / 10}%"
    }

    private fun loadDevices() {
        val ins = AudioEngine.inputs()
        val outs = AudioEngine.outputs()
        inputBox.removeAllItems(); ins.forEach { inputBox.addItem(it) }
        outputBox.removeAllItems(); outs.forEach { outputBox.addItem(it) }
        val r = object : DefaultListCellRenderer() {
            override fun getListCellRendererComponent(l: JList<*>?, v: Any?, i: Int, s: Boolean, f: Boolean) =
                super.getListCellRendererComponent(l, (v as? Mixer.Info)?.name ?: "", i, s, f)
        }
        inputBox.renderer = r; outputBox.renderer = r

        // 저장된 선택 → 없으면 CABLE Output 자동 선택
        val savedIn = prefs.get("input", null)
        val savedOut = prefs.get("output", null)
        (ins.firstOrNull { it.name == savedIn } ?: ins.firstOrNull { it.name.contains("CABLE Output", true) }
            ?: ins.firstOrNull { it.name.contains("BlackHole", true) })?.let { inputBox.selectedItem = it }
        (outs.firstOrNull { it.name == savedOut }
            ?: outs.firstOrNull { !isVirtual(it.name) && !it.name.contains("Primary", true) && !it.name.contains("기본", true) })
            ?.let { outputBox.selectedItem = it }

        status.text = if (ins.none { isVirtual(it.name) })
            "⚠️ 가상 케이블(VB-CABLE)이 안 보입니다 → '처음 설정 방법'을 눌러 주세요"
        else "준비됨 — 장치 확인 후 [시작]"
    }

    private fun isVirtual(n: String) = n.contains("CABLE", true) || n.contains("BlackHole", true)

    private fun startEngine() {
        val i = inputBox.selectedItem as? Mixer.Info
        val o = outputBox.selectedItem as? Mixer.Info
        if (i == null || o == null) { status.text = "입력/출력 장치를 골라 주세요"; return }
        if (isVirtual(o.name)) {
            JOptionPane.showMessageDialog(this, "출력은 'CABLE'이 아니라 실제 헤드폰/스피커를 골라야 합니다.\n(같은 케이블로 내보내면 소리가 무한 반복됩니다)")
            return
        }
        prefs.put("input", i.name); prefs.put("output", o.name)
        val e = AudioEngine(i, o, settings) { msg -> SwingUtilities.invokeLater { status.text = "❌ $msg"; refreshButton() } }
        e.bypass = !enable3d.isSelected
        e.start()
        if (e.isRunning) {
            engine = e
            status.text = "✅ 3D 적용 중 (${e.sampleRate} Hz) — Windows 출력이 'CABLE Input'인지 확인"
        }
        refreshButton()
    }

    private fun stopEngine() {
        engine?.stop(); engine = null
        status.text = "⏹ 정지됨"
        refreshButton()
    }

    private fun refreshButton() {
        startBtn.text = if (engine?.isRunning == true) "⏹ 정지" else "▶ 시작"
    }

    private fun showHelp() {
        JOptionPane.showMessageDialog(
            this,
            """
            <html><body style='width:380px'>
            <h3>처음 한 번만 설정 (Windows)</h3>
            <b>1.</b> 무료 가상 오디오 장치 <b>VB-CABLE</b> 설치<br>
            &nbsp;&nbsp;&nbsp;vb-audio.com/Cable → Download → 압축 풀고<br>
            &nbsp;&nbsp;&nbsp;<b>VBCABLE_Setup_x64.exe</b> 우클릭 → 관리자 권한으로 실행 → Install → 재부팅<br><br>
            <b>2.</b> 작업표시줄 오른쪽 🔊 아이콘 클릭 → 출력 장치를 <b>CABLE Input</b> 으로 변경<br>
            &nbsp;&nbsp;&nbsp;(이제 모든 소리가 이 프로그램으로 들어옵니다)<br><br>
            <b>3.</b> 이 프로그램에서<br>
            &nbsp;&nbsp;&nbsp;입력 = <b>CABLE Output</b>, 출력 = <b>내 헤드폰</b> → [▶ 시작]<br><br>
            <b>끝낼 때:</b> 🔊 출력 장치를 다시 헤드폰으로 바꾸면 원래대로 돌아갑니다.<br><br>
            <i>Mac: VB-CABLE 대신 무료 'BlackHole 2ch' 를 설치하고 같은 방식으로 쓰면 됩니다.</i>
            </body></html>
            """.trimIndent(),
            "처음 설정 방법", JOptionPane.INFORMATION_MESSAGE,
        )
    }

    private fun loadSettings() = SpatialSettings(
        virtualizerStrength = prefs.getInt("strength", 850),
        bassStrength = prefs.getInt("bass", 250),
        spaceEq = prefs.getInt("room", 45),
        reverbPreset = prefs.getInt("reverb", 2),
        width = prefs.getInt("width", 65),
        frontAngle = prefs.getInt("front", 45),
        rearAngle = prefs.getInt("rearAngle", 135),
        rearLevel = prefs.getInt("rearLevel", 45),
        centerLevel = prefs.getInt("center", 70),
        engineMode = prefs.getInt("engine", 1),
        spread = prefs.getInt("spread", 90),
        earSize = prefs.getInt("ear", 2),
        hpEq = prefs.getInt("hpEq", 0),
    )

    private fun saveSettings() {
        prefs.putInt("strength", settings.virtualizerStrength); prefs.putInt("bass", settings.bassStrength)
        prefs.putInt("room", settings.spaceEq); prefs.putInt("reverb", settings.reverbPreset)
        prefs.putInt("width", settings.width)
        prefs.putInt("front", settings.frontAngle); prefs.putInt("rearAngle", settings.rearAngle)
        prefs.putInt("rearLevel", settings.rearLevel); prefs.putInt("center", settings.centerLevel)
        prefs.putInt("engine", settings.engineMode); prefs.putInt("spread", settings.spread); prefs.putInt("ear", settings.earSize)
        prefs.putInt("hpEq", settings.hpEq)
    }

    private fun pickFont(): Font {
        val names = java.awt.GraphicsEnvironment.getLocalGraphicsEnvironment().availableFontFamilyNames.toSet()
        val name = listOf("Malgun Gothic", "맑은 고딕", "Apple SD Gothic Neo", "Noto Sans CJK KR", "NanumGothic")
            .firstOrNull { it in names } ?: Font.DIALOG
        return Font(name, Font.PLAIN, 13)
    }

    private fun applyFont(c: java.awt.Container) {
        for (child in c.components) {
            if (child.font == null || child.font.size == 12 || child.font.size == 11 || child.font.size == 13) {
                if (child !is JLabel || child.font?.isBold != true) child.font = font
            }
            if (child is java.awt.Container) applyFont(child)
        }
    }
}
