package com.example.datastreamer;

import io.appium.java_client.android.AndroidDriver;
import io.appium.java_client.android.options.UiAutomator2Options;
import org.junit.jupiter.api.*;

import java.net.MalformedURLException;
import java.net.URL;
import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Full example test for the appium-data-streamer plugin.
 *
 * Prerequisites:
 *   1. Build the plugin:
 *        cd data-streamer && npm run build
 *
 *   2. Install the plugin locally into Appium:
 *        appium plugin install --source=local /path/to/data-streamer
 *
 *   3. Start Appium with the plugin activated:
 *        appium --use-plugins=data-streamer
 *
 *   4. Have an Android emulator/device running with the target app installed.
 */
public class DataStreamerPluginTest {

    private static AndroidDriver driver;

    @BeforeAll
    static void setUp() throws MalformedURLException {
        UiAutomator2Options options = new UiAutomator2Options()
                .setDeviceName("emulator-5554")
                .setApp("/path/to/your/app.apk")          // <-- replace with your APK path
                .setAppPackage("com.example.myapp")        // <-- replace with your app package
                .setAppActivity(".MainActivity")           // <-- replace with your main activity
                .setAutomationName("UiAutomator2")
                .setNewCommandTimeout(Duration.ofSeconds(300));

        // Connect to Appium server (started with --use-plugins=data-streamer)
        driver = new AndroidDriver(new URL("http://127.0.0.1:4723"), options);
        driver.manage().timeouts().implicitlyWait(Duration.ofSeconds(10));
    }

    @AfterAll
    static void tearDown() {
        if (driver != null) {
            driver.quit();
        }
    }

    // -----------------------------------------------------------------------
    //  Test 1: Basic start → wait → stop flow
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("Collect text samples from an element over 5 seconds")
    void testStartAndStopTextCollection() throws InterruptedException {

        // --- START collection ---
        Map<String, Object> startParams = new HashMap<>();
        startParams.put("name", "price-monitor");
        startParams.put("locator", Map.of(
                "using", "id",
                "value", "com.example.myapp:id/price_label"   // <-- replace with real element ID
        ));
        startParams.put("intervalMs", 200);  // poll every 200ms

        @SuppressWarnings("unchecked")
        Map<String, Object> startResult = (Map<String, Object>)
                driver.executeScript("dataStreamer: startTextCollection", startParams);

        // Verify start response
        assertNotNull(startResult);
        assertEquals("price-monitor", startResult.get("name"));
        assertNotNull(startResult.get("elementId"));
        assertEquals(200L, ((Number) startResult.get("intervalMs")).longValue());
        System.out.println("✓ Started collection: " + startResult);

        // --- Let it collect for 5 seconds ---
        Thread.sleep(5000);

        // --- STOP collection ---
        Map<String, Object> stopParams = new HashMap<>();
        stopParams.put("name", "price-monitor");

        @SuppressWarnings("unchecked")
        Map<String, Object> stopResult = (Map<String, Object>)
                driver.executeScript("dataStreamer: stopTextCollection", stopParams);

        // Verify stop response
        assertNotNull(stopResult);
        assertEquals("price-monitor", stopResult.get("name"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> samples = (List<Map<String, Object>>) stopResult.get("samples");
        assertNotNull(samples);
        assertTrue(samples.size() > 0, "Should have collected at least 1 sample");

        long sampleCount = ((Number) stopResult.get("sampleCount")).longValue();
        long durationMs = ((Number) stopResult.get("durationMs")).longValue();
        assertEquals(samples.size(), sampleCount);
        assertTrue(durationMs >= 4500, "Duration should be ~5000ms");

        // Print collected data
        System.out.println("✓ Stopped collection. Samples: " + sampleCount
                + ", Duration: " + durationMs + "ms");
        System.out.println("--- Collected Samples ---");
        for (Map<String, Object> sample : samples) {
            System.out.printf("  [%dms] text=\"%s\"  (timestamp=%d)%n",
                    ((Number) sample.get("elapsed")).longValue(),
                    sample.get("text"),
                    ((Number) sample.get("timestamp")).longValue());
        }
    }

    // -----------------------------------------------------------------------
    //  Test 2: Multiple concurrent collections with different names
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("Run two text collections simultaneously on different elements")
    void testMultipleConcurrentCollections() throws InterruptedException {

        // Start collection A
        Map<String, Object> startA = new HashMap<>();
        startA.put("name", "title-watch");
        startA.put("locator", Map.of(
                "using", "id",
                "value", "com.example.myapp:id/title"         // <-- replace
        ));
        startA.put("intervalMs", 300);
        driver.executeScript("dataStreamer: startTextCollection", startA);

        // Start collection B
        Map<String, Object> startB = new HashMap<>();
        startB.put("name", "counter-watch");
        startB.put("locator", Map.of(
                "using", "id",
                "value", "com.example.myapp:id/counter"       // <-- replace
        ));
        startB.put("intervalMs", 100);
        driver.executeScript("dataStreamer: startTextCollection", startB);

        // Let both run for 3 seconds
        Thread.sleep(3000);

        // Stop A
        @SuppressWarnings("unchecked")
        Map<String, Object> resultA = (Map<String, Object>)
                driver.executeScript("dataStreamer: stopTextCollection",
                        Map.of("name", "title-watch"));

        // Stop B
        @SuppressWarnings("unchecked")
        Map<String, Object> resultB = (Map<String, Object>)
                driver.executeScript("dataStreamer: stopTextCollection",
                        Map.of("name", "counter-watch"));

        @SuppressWarnings("unchecked")
        List<?> samplesA = (List<?>) resultA.get("samples");
        @SuppressWarnings("unchecked")
        List<?> samplesB = (List<?>) resultB.get("samples");

        System.out.println("✓ title-watch samples: " + samplesA.size());
        System.out.println("✓ counter-watch samples: " + samplesB.size());

        // B should have more samples (100ms interval vs 300ms)
        assertTrue(samplesB.size() > samplesA.size(),
                "Faster interval should yield more samples");
    }

    // -----------------------------------------------------------------------
    //  Test 3: Using accessibility id locator
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("Collect text using accessibility id locator strategy")
    void testWithAccessibilityId() throws InterruptedException {

        Map<String, Object> startParams = new HashMap<>();
        startParams.put("name", "status-tracker");
        startParams.put("locator", Map.of(
                "using", "accessibility id",
                "value", "status_text"                       // <-- replace
        ));
        // omit intervalMs → uses plugin default (500ms)

        driver.executeScript("dataStreamer: startTextCollection", startParams);

        Thread.sleep(2000);

        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>)
                driver.executeScript("dataStreamer: stopTextCollection",
                        Map.of("name", "status-tracker"));

        @SuppressWarnings("unchecked")
        List<?> samples = (List<?>) result.get("samples");
        System.out.println("✓ status-tracker samples (500ms default interval): " + samples.size());

        // At 500ms interval over 2s, expect ~4 samples
        assertTrue(samples.size() >= 2 && samples.size() <= 6);
    }

    // -----------------------------------------------------------------------
    //  Test 4: Using xpath locator
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("Collect text using xpath locator strategy")
    void testWithXpath() throws InterruptedException {

        Map<String, Object> startParams = new HashMap<>();
        startParams.put("name", "xpath-collection");
        startParams.put("locator", Map.of(
                "using", "xpath",
                "value", "//android.widget.TextView[@resource-id='com.example.myapp:id/timer']"
        ));
        startParams.put("intervalMs", 100);

        driver.executeScript("dataStreamer: startTextCollection", startParams);
        Thread.sleep(3000);

        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>)
                driver.executeScript("dataStreamer: stopTextCollection",
                        Map.of("name", "xpath-collection"));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> samples =
                (List<Map<String, Object>>) result.get("samples");

        System.out.println("✓ xpath-collection samples: " + samples.size());
        assertTrue(samples.size() >= 20, "100ms interval over 3s should yield ~30 samples");

        // Verify each sample has expected fields
        for (Map<String, Object> sample : samples) {
            assertNotNull(sample.get("timestamp"), "Each sample must have a timestamp");
            assertNotNull(sample.get("text"), "Each sample must have text");
            assertNotNull(sample.get("elapsed"), "Each sample must have elapsed time");
        }
    }

    // -----------------------------------------------------------------------
    //  Test 5: Error — stop a collection that was never started
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("Stopping a non-existent collection should throw an error")
    void testStopNonExistentCollection() {
        Map<String, Object> stopParams = Map.of("name", "does-not-exist");

        Exception exception = assertThrows(Exception.class, () ->
                driver.executeScript("dataStreamer: stopTextCollection", stopParams));

        System.out.println("✓ Expected error: " + exception.getMessage());
    }

    // -----------------------------------------------------------------------
    //  Test 6: Error — duplicate name
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("Starting a collection with a duplicate name should throw an error")
    void testDuplicateNameError() throws InterruptedException {
        Map<String, Object> params = new HashMap<>();
        params.put("name", "duplicate-test");
        params.put("locator", Map.of(
                "using", "id",
                "value", "com.example.myapp:id/price_label"  // <-- replace
        ));

        // Start first
        driver.executeScript("dataStreamer: startTextCollection", params);

        // Try to start with same name → should fail
        try {
            Exception exception = assertThrows(Exception.class, () ->
                    driver.executeScript("dataStreamer: startTextCollection", params));
            System.out.println("✓ Expected duplicate error: " + exception.getMessage());
        } finally {
            // Clean up
            driver.executeScript("dataStreamer: stopTextCollection",
                    Map.of("name", "duplicate-test"));
        }
    }

    // -----------------------------------------------------------------------
    //  Test 7: clickAndWaitForText — click a button, then wait for a result
    //  element to appear and stream its text back (single-shot, direct-to-UIA2)
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("Click an element and wait for a result locator's text to appear")
    void testClickAndWaitForText() {
        // Element to click, found beforehand via the normal driver API
        String submitButtonId = driver.findElement(
                io.appium.java_client.AppiumBy.id("com.example.myapp:id/submit_button")
        ).getId();

        Map<String, Object> params = new HashMap<>();
        params.put("elementIdToClick", submitButtonId);
        params.put("locator", Map.of(
                "using", "id",
                "value", "com.example.myapp:id/result_label"   // <-- replace with real element
        ));
        params.put("timeoutMs", 10000);  // give the app up to 10s to show the result

        @SuppressWarnings("unchecked")
        Map<String, Object> result = (Map<String, Object>)
                driver.executeScript("dataStreamer: clickAndWaitForText", params);

        assertNotNull(result);
        assertNotNull(result.get("elementId"));
        assertNotNull(result.get("text"));

        long elapsedMs = ((Number) result.get("elapsedMs")).longValue();
        System.out.println("✓ Result text: \"" + result.get("text")
                + "\" (found after " + elapsedMs + "ms)");
    }

    // -----------------------------------------------------------------------
    //  Test 8: clickAndWaitForText — timeout when the result never appears
    // -----------------------------------------------------------------------
    @Test
    @DisplayName("clickAndWaitForText should throw when the locator never matches in time")
    void testClickAndWaitForTextTimeout() {
        String submitButtonId = driver.findElement(
                io.appium.java_client.AppiumBy.id("com.example.myapp:id/submit_button")
        ).getId();

        Map<String, Object> params = new HashMap<>();
        params.put("elementIdToClick", submitButtonId);
        params.put("locator", Map.of(
                "using", "id",
                "value", "com.example.myapp:id/does_not_exist"  // never appears
        ));
        params.put("timeoutMs", 2000);  // short timeout to keep the test fast

        Exception exception = assertThrows(Exception.class, () ->
                driver.executeScript("dataStreamer: clickAndWaitForText", params));

        System.out.println("✓ Expected timeout error: " + exception.getMessage());
    }
}
