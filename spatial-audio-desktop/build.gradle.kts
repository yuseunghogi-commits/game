plugins {
    kotlin("jvm") version "1.9.24"
    application
}

// 3D 엔진은 안드로이드 앱과 같은 파일을 그대로 사용 (한 곳만 고치면 둘 다 반영)
val sharedDir = layout.buildDirectory.dir("shared-src")
val copyShared by tasks.registering(Copy::class) {
    from("../spatial-audio-android/app/src/main/java/com/spatialsound/app") {
        include("BinauralProcessor.kt", "HrtfRenderer.kt", "HrirSet.kt", "Fft.kt", "HeadphoneEq.kt", "RoomModel.kt", "ElevationSet.kt")
    }
    into(sharedDir.map { it.dir("com/spatialsound/app") })
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
kotlin {
    sourceSets["main"].kotlin.srcDir(sharedDir)
}
// 실측 HRIR 데이터도 안드로이드 assets 의 같은 파일을 사용
sourceSets["main"].resources.srcDir("../spatial-audio-android/app/src/main/assets")
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    kotlinOptions.jvmTarget = "17"
}
tasks.named("compileKotlin") { dependsOn(copyShared) }

application {
    mainClass.set("com.spatialsound.desktop.MainKt")
    applicationName = "3DSound"
}

// 실행 파일 하나로 묶은 jar (java -jar 3DSound.jar)
tasks.register<Jar>("fatJar") {
    archiveFileName.set("3DSound.jar")
    manifest { attributes["Main-Class"] = "com.spatialsound.desktop.MainKt" }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    from(sourceSets.main.get().output)
    dependsOn(configurations.runtimeClasspath)
    from({ configurations.runtimeClasspath.get().filter { it.name.endsWith("jar") }.map { zipTree(it) } })
}
