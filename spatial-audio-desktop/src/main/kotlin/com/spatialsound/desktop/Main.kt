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
        MainWindow::class.java.getResourceAsStream("/hrir_mit_elev.bin")?.use {
            com.spatialsound.app.BinauralProcessor.elevBase = com.spatialsound.app.ElevationSet.load(it)
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
    private val sElev = slider(-20, 40, settings.frontElev)
    private val sHeight = slider(0, 100, settings.heightLevel)
    private val sTopAz = slider(0, 90, settings.topAngle)
    private val sTopEl = slider(30, 85, settings.topElev)
    private val sTopRearAz = slider(90, 180, settings.topRearAngle)
    private val sTopRearEl = slider(30, 85, settings.topRearElev)
    private val sBottom = slider(0, 100, settings.bottomLevel)
    private val sBottomAz = slider(0, 180, settings.bottomAngle)
    private val sBottomEl = slider(-40, -10, settings.bottomElev)
    private val sEnhance = slider(0, 100, settings.enhance)
    private val lElev = JLabel(); private val lHeight = JLabel(); private val lTopAz = JLabel(); private val lTopEl = JLabel()
    private val lTopRearAz = JLabel(); private val lTopRearEl = JLabel(); private val lBottom = JLabel()
    private val lBottomAz = JLabel(); private val lBottomEl = JLabel(); private val lEnhance = JLabel()
    /** 실측 엔진에서만 보이는 높이·3D 강조 조절 */
    private val measuredOnly: List<javax.swing.JComponent> get() = listOf(lElev, sElev, lHeight, sHeight, lTopAz, sTopAz, lTopEl, sTopEl, lTopRearAz, sTopRearAz,
        lTopRearEl, sTopRearEl, lBottom, sBottom, lBottomAz, sBottomAz, lBottomEl, sBottomEl, lEnhance, sEnhance)
    private val lFront = JLabel(); private val lRearAngle = JLabel(); private val lRearLevel = JLabel()
    private val lStrength = JLabel(); private val lWidth = JLabel(); private val lRoom = JLabel(); private val lBass = JLabel()
    private val status = JLabel(" ")
    /** 새 버전 알림 (위쪽, 평소엔 숨김) */
    private val updateBar = JPanel(BorderLayout(8, 0))
    private val updateText = JLabel(" ")
    private val updateBtn = JButton("지금 업데이트")
    private var latest: Updater.Release? = null
    private val autoUpdate = JCheckBox("새 버전 자동 확인", prefs.getBoolean("autoUpdate", true))

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

        updateBar.border = BorderFactory.createCompoundBorder(
            BorderFactory.createLineBorder(Color(0xE4, 0xA2, 0x3E)), BorderFactory.createEmptyBorder(6, 8, 6, 8))
        updateBar.add(updateText, BorderLayout.CENTER)
        updateBar.add(updateBtn, BorderLayout.EAST)
        updateBar.isVisible = false
        row(updateBar)
        row(JLabel("3D 사운드").apply { this.font = this@MainWindow.font.deriveFont(Font.BOLD, 22f) })
        row(JLabel("<html>유튜브·게임·영화 소리를 헤드폰용 3D 입체 음향으로</html>"))
        row(JButton("🌐 브라우저(유튜브 등) 소리만이라면 → 설치 없이 웹 앱으로").apply {
            toolTipText = Updater.WEB_APP
            addActionListener { Updater.browse(Updater.WEB_APP) }
        })

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
        row(lEnhance); row(sEnhance)

        row(title("③ 소리 조절"))
        row(JLabel("프리셋")); row(presetBox)
        row(lStrength); row(sStrength)
        row(lFront); row(sFront)
        row(lRearAngle); row(sRearAngle)
        row(lRearLevel); row(sRearLevel)
        row(lCenter); row(sCenter)
        row(lElev); row(sElev)
        row(lHeight); row(sHeight)
        row(lTopAz); row(sTopAz)
        row(lTopEl); row(sTopEl)
        row(lTopRearAz); row(sTopRearAz)
        row(lTopRearEl); row(sTopRearEl)
        row(lBottom); row(sBottom)
        row(lBottomAz); row(sBottomAz)
        row(lBottomEl); row(sBottomEl)
        row(lWidth); row(sWidth)
        row(lRoom); row(sRoom)
        row(JLabel("잔향 (방 크기)")); row(reverbBox)
        row(lBass); row(sBass)

        row(title("앱 정보"))
        val verRow = JPanel(BorderLayout(8, 0))
        verRow.add(JLabel("3D 사운드 PC v${Updater.currentVersion}"), BorderLayout.WEST)
        verRow.add(JButton("업데이트 확인").apply { addActionListener { checkUpdate(manual = true) } }, BorderLayout.EAST)
        row(verRow)
        row(autoUpdate)
        autoUpdate.addActionListener { prefs.putBoolean("autoUpdate", autoUpdate.isSelected) }
        updateBtn.addActionListener { latest?.let { offerUpdate(it) } }

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
                sElev.value = p.frontElev; sHeight.value = p.heightLevel
                sTopAz.value = p.topAngle; sTopEl.value = p.topElev
                sTopRearAz.value = p.topRearAngle; sTopRearEl.value = p.topRearElev
                sBottom.value = p.bottomLevel; sBottomAz.value = p.bottomAngle; sBottomEl.value = p.bottomElev
                sEnhance.value = p.enhance
                applyingPreset = false
                changed()
            }
        }
        listOf(sStrength, sWidth, sRoom, sBass, sFront, sRearAngle, sRearLevel, sCenter, sElev, sHeight, sTopAz, sTopEl, sTopRearAz, sTopRearEl, sBottom, sBottomAz, sBottomEl, sEnhance)
            .forEach { s -> s.addChangeListener { changed() } }
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
        for (c in measuredOnly) c.isVisible = settings.engineMode != 0
        updateLabels()

        pack()
        val screenH = java.awt.Toolkit.getDefaultToolkit().screenSize.height
        size = Dimension(width + 24, minOf(height, (screenH * 0.85).toInt()))
        minimumSize = Dimension(460, 400)
        setLocationRelativeTo(null)

        reportLastUpdate()
        if (autoUpdate.isSelected) checkUpdate(manual = false)
    }

    // --- 업데이트 ---------------------------------------------------------

    private fun checkUpdate(manual: Boolean) {
        Thread {
            val r = runCatching { Updater.fetchLatest() }
            SwingUtilities.invokeLater {
                val rel = r.getOrNull()
                when {
                    rel == null -> if (manual) JOptionPane.showMessageDialog(this, "업데이트 확인 실패 — 인터넷 연결을 확인하세요.\n(${r.exceptionOrNull()?.message})")
                    !Updater.isNewer(rel.version, Updater.currentVersion) -> if (manual) JOptionPane.showMessageDialog(
                        this, if (Updater.currentVersion == "dev") "개발용 실행이라 비교할 수 없습니다 (최신 v${rel.version})" else "최신 버전입니다 (v${Updater.currentVersion})")
                    else -> {
                        latest = rel
                        updateText.text = "🆕 새 버전 v${rel.version} 이 나왔어요 (현재 v${Updater.currentVersion})"
                        updateBar.isVisible = true
                        revalidate()
                        if (manual) offerUpdate(rel)
                    }
                }
            }
        }.apply { isDaemon = true }.start()
    }

    private fun offerUpdate(rel: Updater.Release) {
        val auto = Updater.isWindows && Updater.appExe != null && rel.windowsZip != null
        val notes = rel.notes.ifBlank { "변경 사항은 릴리스 페이지에서 볼 수 있습니다." }
        val msg = "<html><body style='width:380px'><b>v${Updater.currentVersion} → v${rel.version}</b><br><br>" +
            notes.replace("&", "&amp;").replace("<", "&lt;").replace("\n", "<br>") +
            "<br><br>" + (if (auto) "[지금 업데이트]를 누르면 받아서 바꾼 뒤 자동으로 다시 켜집니다. 설정은 그대로입니다."
            else "릴리스 페이지에서 새 파일을 받아 주세요.") + "</body></html>"
        val options = if (auto) arrayOf("지금 업데이트", "릴리스 페이지", "나중에") else arrayOf("릴리스 페이지", "나중에")
        val pick = JOptionPane.showOptionDialog(this, msg, "새 버전 v${rel.version}", JOptionPane.DEFAULT_OPTION,
            JOptionPane.INFORMATION_MESSAGE, null, options, options[0])
        when (options.getOrNull(pick)) {
            "지금 업데이트" -> installWindows(rel)
            "릴리스 페이지" -> Updater.browse(rel.page)
        }
    }

    /** Windows 앱: zip 받기 → 풀기 → 앱 종료 후 교체·재실행 스크립트 */
    private fun installWindows(rel: Updater.Release) {
        val url = rel.windowsZip ?: return
        val bar = javax.swing.JProgressBar(0, 1000)
        val dlg = javax.swing.JDialog(this, "v${rel.version} 받는 중…", true)
        dlg.contentPane = JPanel(BorderLayout()).apply {
            border = BorderFactory.createEmptyBorder(16, 16, 16, 16)
            add(JLabel("새 버전을 받는 중입니다 (끝나면 앱이 다시 켜집니다)"), BorderLayout.NORTH)
            add(bar, BorderLayout.CENTER)
        }
        dlg.defaultCloseOperation = WindowConstants.DO_NOTHING_ON_CLOSE
        dlg.pack(); dlg.setSize(maxOf(dlg.width, 380), dlg.height); dlg.setLocationRelativeTo(this)
        Thread {
            val r = runCatching {
                val work = java.nio.file.Files.createTempDirectory("3dsound-update").toFile()
                val zip = java.io.File(work, "update.zip").toPath()
                Updater.download(url, zip) { d, t -> if (t > 0) SwingUtilities.invokeLater { bar.value = (d * 1000 / t).toInt() } }
                val ex = java.io.File(work, "new")
                Updater.unzip(zip, ex.toPath())
                java.nio.file.Files.deleteIfExists(zip)
                val newApp = java.io.File(ex, "3DSound")
                require(java.io.File(newApp, "3DSound.exe").isFile && java.io.File(newApp, "app").isDirectory) { "받은 파일의 구성이 예상과 다릅니다" }
                newApp to work
            }
            SwingUtilities.invokeLater {
                dlg.dispose()
                r.onSuccess { (newApp, work) ->
                    engine?.stop(); engine = null
                    val launched = runCatching { Updater.launchWindowsSwap(newApp, work) }
                    if (launched.isSuccess) {
                        dispose()
                        System.exit(0)
                    } else updateFailed(rel, launched.exceptionOrNull()?.message)
                }.onFailure { updateFailed(rel, it.message) }
            }
        }.apply { isDaemon = true }.start()
        dlg.isVisible = true
    }

    private fun updateFailed(rel: Updater.Release, why: String?) {
        val pick = JOptionPane.showOptionDialog(this, "업데이트하지 못했습니다: ${why ?: "알 수 없는 오류"}\n릴리스 페이지에서 직접 받을 수 있습니다.",
            "업데이트 실패", JOptionPane.DEFAULT_OPTION, JOptionPane.WARNING_MESSAGE, null, arrayOf("릴리스 페이지", "닫기"), "릴리스 페이지")
        if (pick == 0) Updater.browse(rel.page)
    }

    /** 지난번 자동 업데이트 결과 알려 주기 (교체 스크립트가 남긴 파일) */
    private fun reportLastUpdate() {
        val f = Updater.resultFile
        if (!f.isFile) return
        val text = runCatching { f.readText().trim().trimStart('\uFEFF') }.getOrDefault("")
        f.delete()
        SwingUtilities.invokeLater {
            if (text.startsWith("ok")) status.text = "✅ v${Updater.currentVersion} 로 업데이트됐습니다"
            else JOptionPane.showMessageDialog(this,
                "지난 업데이트에서 파일을 바꾸지 못했습니다 ($text).\n" +
                    "앱 폴더에 쓸 수 없는 위치(예: Program Files)일 수 있습니다.\n" +
                    "릴리스 페이지에서 zip 을 받아 다른 폴더(예: 바탕화면)에 풀어 쓰세요.")
        }
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
            frontElev = sElev.value, heightLevel = sHeight.value,
            topAngle = sTopAz.value, topElev = sTopEl.value,
            topRearAngle = sTopRearAz.value, topRearElev = sTopRearEl.value,
            bottomLevel = sBottom.value, bottomAngle = sBottomAz.value, bottomElev = sBottomEl.value,
            enhance = sEnhance.value,
        )
        val measured = settings.engineMode != 0
        for (c in measuredOnly) c.isVisible = measured
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
            ?.let { "측정: ${it.source} · 필터 ${it.filters.size}개 (AutoEq, 부드럽게: 본래 저음 유지)" } ?: " "
        lWidth.text = "좌우 분리 (반대쪽 귀로 새는 소리 줄이기): ${sWidth.value}%"
        lFront.text = "앞 스피커 각도: ±${sFront.value}° (작을수록 정면)"
        lRearAngle.text = "뒤 스피커 각도: ±${sRearAngle.value}° (90°=옆, 180°=바로 뒤)"
        val classic = engineBox.selectedIndex == 2
        lRearLevel.text = if (classic) "뒤 스피커 양: ${sRearLevel.value}% (0이면 전부 앞에서)"
        else "배경음 옆/뒤 비율: ${sRearLevel.value}% (박수·관중·울림을 옆/뒤로)"
        lCenter.text = "가운데 스피커: ${sCenter.value}% (보컬·대사를 정면에)"
        lElev.text = "앞 스피커 높이: " + when { sElev.value > 0 -> "위 ${sElev.value}°"; sElev.value < 0 -> "아래 ${-sElev.value}°"; else -> "귀 높이 (0°)" }
        lHeight.text = "▲ 천장 스피커 4개 (앞 2·뒤 2): ${sHeight.value}%"
        val topOff = if (sHeight.value == 0) " · 천장 0%라 꺼짐" else ""
        val botOff = if (sBottom.value == 0) " · 바닥 0%라 꺼짐" else ""
        lTopAz.text = "천장 앞 ▲ 방향: ±${sTopAz.value}° (0 = 정면, 90 = 머리 옆)$topOff"
        lTopEl.text = "천장 앞 ▲ 높이: 위 ${sTopEl.value}° (90° = 머리 바로 위)"
        lTopRearAz.text = "천장 뒤 ▲ 방향: ±${sTopRearAz.value}° (90 = 머리 옆, 180 = 바로 뒤)$topOff"
        lTopRearEl.text = "천장 뒤 ▲ 높이: 위 ${sTopRearEl.value}°"
        lBottom.text = "▼ 바닥 스피커 2개: ${sBottom.value}% (배경음 일부를 아래쪽에서, 0이면 없음)"
        lBottomAz.text = "바닥 ▼ 방향: ±${sBottomAz.value}° (0 = 정면, 180 = 바로 뒤)$botOff"
        lBottomEl.text = "바닥 ▼ 높이: 아래 ${-sBottomEl.value}°"
        lEnhance.text = "✨ 3D 강조: ${sEnhance.value}% (뒤는 더 뒤처럼, 위·아래는 더 위·아래처럼 · 0 = 측정 그대로)"
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
            <i>Mac: VB-CABLE 대신 무료 'BlackHole 2ch' 를 설치하고 같은 방식으로 쓰면 됩니다.</i><br><br>
            <b>💡 유튜브처럼 브라우저 소리만이라면</b> VB-CABLE 없이 웹 앱으로 됩니다:<br>
            &nbsp;&nbsp;&nbsp;크롬·엣지에서 ${Updater.WEB_APP} → [다른 탭 소리]
            </body></html>
            """.trimIndent(),
            "처음 설정 방법", JOptionPane.INFORMATION_MESSAGE,
        )
    }

    private fun loadSettings() = migrateStrength(SpatialSettings(
        virtualizerStrength = prefs.getInt("strength", 1000),
        bassStrength = prefs.getInt("bass", 250),
        spaceEq = prefs.getInt("room", 45),
        reverbPreset = prefs.getInt("reverb", 2),
        width = prefs.getInt("width", 65),
        frontAngle = prefs.getInt("front", 45),
        rearAngle = prefs.getInt("rearAngle", 135),
        rearLevel = prefs.getInt("rearLevel", 45),
        centerLevel = prefs.getInt("center", 70),
        frontElev = prefs.getInt("elev", 0),
        heightLevel = prefs.getInt("height", 25),
        topAngle = prefs.getInt("topAz2", 45),
        topElev = prefs.getInt("topEl2", 45),
        topRearAngle = prefs.getInt("topRearAz", 135),
        topRearElev = prefs.getInt("topRearEl", 45),
        bottomLevel = prefs.getInt("bottom", 10),
        bottomAngle = prefs.getInt("bottomAz", 45),
        bottomElev = prefs.getInt("bottomEl", -30),
        enhance = prefs.getInt("enhance", 30),
        engineMode = prefs.getInt("engine", 1),
        spread = prefs.getInt("spread", 90),
        earSize = prefs.getInt("ear", 2),
        hpEq = prefs.getInt("hpEq", 0),
    ))

    /** v1.8: 프리셋 3D 강도 85/95/65% → 100/100/85% — 저장값이 예전 프리셋/기본값 그대로면 옮김 */
    private fun migrateStrength(s: SpatialSettings): SpatialSettings {
        if (prefs.getInt("ver", 0) >= 2 || prefs.get("strength", null) == null) return s
        val preset = prefs.getInt("preset", 0)
        val before = mapOf(0 to 850, 2 to 950, 4 to 650); val after = mapOf(0 to 1000, 2 to 1000, 4 to 850)
        return when {
            before[preset] == s.virtualizerStrength -> s.copy(virtualizerStrength = after.getValue(preset))
            preset == SOUND_PRESETS.size && s.virtualizerStrength == 850 -> s.copy(virtualizerStrength = 1000)
            else -> s
        }
    }

    private fun saveSettings() {
        prefs.putInt("ver", 2)
        prefs.putInt("strength", settings.virtualizerStrength); prefs.putInt("bass", settings.bassStrength)
        prefs.putInt("room", settings.spaceEq); prefs.putInt("reverb", settings.reverbPreset)
        prefs.putInt("width", settings.width)
        prefs.putInt("front", settings.frontAngle); prefs.putInt("rearAngle", settings.rearAngle)
        prefs.putInt("rearLevel", settings.rearLevel); prefs.putInt("center", settings.centerLevel)
        prefs.putInt("elev", settings.frontElev); prefs.putInt("height", settings.heightLevel)
        prefs.putInt("topAz2", settings.topAngle); prefs.putInt("topEl2", settings.topElev)
        prefs.putInt("topRearAz", settings.topRearAngle); prefs.putInt("topRearEl", settings.topRearElev)
        prefs.putInt("bottom", settings.bottomLevel); prefs.putInt("bottomAz", settings.bottomAngle); prefs.putInt("bottomEl", settings.bottomElev)
        prefs.putInt("enhance", settings.enhance)
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
