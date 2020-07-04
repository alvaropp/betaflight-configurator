'use strict';

TABS.logging = {
    feature3DEnabled: false,
    escProtocolIsDshot: false,
    sensor: "gyro",
    sensorGyroRate: 20,
    sensorGyroScale: 2000,
    sensorAccelRate: 20,
    sensorAccelScale: 2,
    sensorSelectValues: {
        "gyroScale": {
            "10": 10,
            "25": 25,
            "50": 50,
            "100": 100,
            "200": 200,
            "300": 300,
            "400": 400,
            "500": 500,
            "1000": 1000,
            "2000": 2000
        },
        "accelScale": {
            "0.05": 0.05,
            "0.1": 0.1,
            "0.2": 0.2,
            "0.3": 0.3,
            "0.4": 0.4,
            "0.5": 0.5,
            "1": 1,
            "2": 2
        }
    },
    // These are translated into proper Dshot values on the flight controller
    DSHOT_DISARMED_VALUE: 1000,
    DSHOT_MAX_VALUE: 2000,
    DSHOT_3D_NEUTRAL: 1500
};

TABS.logging.initialize = function (callback) {
    var self = this;

    self.armed = false;
    self.escProtocolIsDshot = false;

    var requested_properties = [],
        samples = 0,
        requests = 0,
        log_buffer = [];

    if (GUI.active_tab != 'logging') {
        GUI.active_tab = 'logging';
    }

    function get_arm_status() {
        MSP.send_message(MSPCodes.MSP_STATUS, false, false, load_feature_config);
    }

    function load_feature_config() {
        MSP.send_message(MSPCodes.MSP_FEATURE_CONFIG, false, false, load_motor_3d_config);
    }

    function load_motor_3d_config() {
        MSP.send_message(MSPCodes.MSP_MOTOR_3D_CONFIG, false, false, load_esc_protocol);
    }

    function load_esc_protocol() {
        MSP.send_message(MSPCodes.MSP_ADVANCED_CONFIG, false, false, load_motor_data);
    }

    function load_motor_data() {
        MSP.send_message(MSPCodes.MSP_MOTOR, false, false, load_motor_telemetry_data);
    }

    function load_motor_telemetry_data() {
        if (MOTOR_CONFIG.use_dshot_telemetry || MOTOR_CONFIG.use_esc_sensor) {
            MSP.send_message(MSPCodes.MSP_MOTOR_TELEMETRY, false, false, load_mixer_config);
        } else {
            load_mixer_config();
        }
    }

    function load_mixer_config() {
        MSP.send_message(MSPCodes.MSP_MIXER_CONFIG, false, false, load_html);
    }

    if (CONFIGURATOR.connectionValid) {
        var get_motor_data = function () {
            MSP.send_message(MSPCodes.MSP_MOTOR, false, false, load_html);
        }

        var load_html = function () {
            $('#content').load("./tabs/logging.html", process_html);
        }

        MSP.send_message(MSPCodes.MSP_RC, false, false, get_motor_data);
    }

    // Get information from Betaflight
    if (semver.gte(CONFIG.apiVersion, "1.36.0")) {
        // BF 3.2.0+
        MSP.send_message(MSPCodes.MSP_MOTOR_CONFIG, false, false, get_arm_status);
    } else {
        // BF 3.1.x or older
        MSP.send_message(MSPCodes.MSP_MISC, false, false, get_arm_status);
    }

    function update_arm_status() {
        self.armed = bit_check(CONFIG.mode, 0);
    }

    /////////////////////////////////////////////////////////////////////////////////////////////////////////

    function process_html() {
        // translate to user-selected language
        i18n.localizePage();

        update_arm_status();
        self.feature3DEnabled = FEATURE_CONFIG.features.isEnabled('3D');

        if (PID_ADVANCED_CONFIG.fast_pwm_protocol >= TABS.configuration.DSHOT_PROTOCOL_MIN_VALUE) {
            self.escProtocolIsDshot = true;
        } else {
            self.escProtocolIsDshot = false;
        }

        // UI hooks
        $('#motorsEnableTestMode').prop('checked', false);

        if (semver.lt(CONFIG.apiVersion, "1.42.0") || !(MOTOR_CONFIG.use_dshot_telemetry || MOTOR_CONFIG.use_esc_sensor)) {
            $(".motor_testing .telemetry").hide();
        } else {
            // Hide telemetry from unused motors (to hide the tooltip in an empty blank space)
            for (let i = MOTOR_CONFIG.motor_count; i < MOTOR_DATA.length; i++) {
                $(".motor_testing .telemetry .motor-" + i).hide();
            }
        }

        $('a.log_file').click(prepare_file);

        //////////////////////////////////////////////////////////////// 
        $('a.motor_sweep').click(function () {
            if ($('#motorsEnableTestMode').is(':checked')) {
                GUI.log(i18n.getMessage('motorSweepStart'));
                motorSweep();
            }
        });

        var motor_speed = 1000;
        var motor_speed_min = 1000;
        var motor_speed_max = 1100;
        var motor_sweep_sense = 1;
        var motor_sweep_delay = 50;
        function motorSweep() {
            setTimeout(function () {
                $('div.sliders input.master').val(motor_speed);
                $('div.sliders input:not(:disabled, :last)').val(motor_speed);
                $('div.values li:not(:last)').slice(0, number_of_valid_outputs).text(motor_speed);
                $('div.sliders input:not(:last):first').trigger('input');
                if (motor_sweep_sense == 1) {
                    motor_speed++;
                    if (motor_speed < motor_speed_max) {
                        motorSweep();
                    } else {
                        motor_sweep_sense = -1;
                        motorSweep();
                    }
                }
                else {
                    motor_speed--;
                    if (motor_speed >= motor_speed_min) {
                        motorSweep();
                    } else {
                        motor_sweep_sense = 1;
                        GUI.log(i18n.getMessage('motorSweepEnd'));
                    }
                }
            }, motor_sweep_delay)
        };
        //////////////////////////////////////////////////////////////// 

        $('a.logging').click(function () {
            if (GUI.connected_to) {
                if (fileEntry != null) {
                    var clicks = $(this).data('clicks');

                    if (!clicks) {
                        // reset some variables before start
                        samples = 0;
                        requests = 0;
                        log_buffer = [];
                        requested_properties = [];

                        $('.properties input:checked').each(function () {
                            requested_properties.push($(this).prop('name'));
                        });

                        if (requested_properties.length) {
                            // print header for the csv file
                            print_head();

                            var log_data_poll = function () {
                                if (requests) {
                                    // save current data (only after everything is initialized)
                                    crunch_data();
                                }

                                // request new
                                for (var i = 0; i < requested_properties.length; i++, requests++) {
                                    MSP.send_message(MSPCodes[requested_properties[i]]);
                                }
                            }

                            GUI.interval_add('log_data_poll', log_data_poll, parseInt($('select.speed').val()), true); // refresh rate goes here
                            GUI.interval_add('write_data', function write_data() {
                                if (log_buffer.length) { // only execute when there is actual data to write
                                    if (fileWriter.readyState == 0 || fileWriter.readyState == 2) {
                                        append_to_file(log_buffer.join('\n'));

                                        $('.samples').text(samples += log_buffer.length);

                                        log_buffer = [];
                                    } else {
                                        console.log('IO having trouble keeping up with the data flow');
                                    }
                                }
                            }, 1000);

                            $('.speed').prop('disabled', true);
                            $(this).text(i18n.getMessage('loggingStop'));
                            $(this).data("clicks", !clicks);
                        } else {
                            GUI.log(i18n.getMessage('loggingErrorOneProperty'));
                        }
                    } else {
                        GUI.interval_kill_all();

                        $('.speed').prop('disabled', false);
                        $(this).text(i18n.getMessage('loggingStart'));
                        $(this).data("clicks", !clicks);
                    }
                } else {
                    GUI.log(i18n.getMessage('loggingErrorLogFile'));
                }
            } else {
                GUI.log(i18n.getMessage('loggingErrorNotConnected'));
            }
        });

        ConfigStorage.get('logging_file_entry', function (result) {
            if (result.logging_file_entry) {
                chrome.fileSystem.restoreEntry(result.logging_file_entry, function (entry) {
                    fileEntry = entry;
                    prepare_writer(true);
                });
            }
        });

        var number_of_valid_outputs = (MOTOR_DATA.indexOf(0) > -1) ? MOTOR_DATA.indexOf(0) : 8;
        var rangeMin;
        var rangeMax;
        var neutral3d;
        if (self.escProtocolIsDshot) {
            rangeMin = self.DSHOT_DISARMED_VALUE;
            rangeMax = self.DSHOT_MAX_VALUE;
            neutral3d = self.DSHOT_3D_NEUTRAL;
        } else {
            rangeMin = MOTOR_CONFIG.mincommand;
            rangeMax = MOTOR_CONFIG.maxthrottle;
            //Arbitrary sanity checks
            //Note: values may need to be revisited
            neutral3d = (MOTOR_3D_CONFIG.neutral > 1575 || MOTOR_3D_CONFIG.neutral < 1425) ? 1500 : MOTOR_3D_CONFIG.neutral;
        }

        $('div.sliders input').prop('min', rangeMin)
            .prop('max', rangeMax);
        $('div.values li:not(:last)').text(rangeMin);
        function setSlidersDefault() {
            // change all values to default
            if (self.feature3DEnabled) {
                $('div.sliders input').val(neutral3d);
            } else {
                $('div.sliders input').val(rangeMin);
            }
        }

        function setSlidersEnabled(isEnabled) {
            if (isEnabled && !self.armed) {
                $('div.sliders input').slice(0, number_of_valid_outputs).prop('disabled', false);

                // unlock master slider
                $('div.sliders input:last').prop('disabled', false);
            } else {
                setSlidersDefault();

                // disable sliders / min max
                $('div.sliders input').prop('disabled', true);
            }

            $('div.sliders input').trigger('input');
        }

        setSlidersDefault();

        $('#motorsEnableTestMode').change(function () {
            var enabled = $(this).is(':checked');

            setSlidersEnabled(enabled);

            $('div.sliders input').trigger('input');

            mspHelper.setArmingEnabled(enabled, enabled);
        }).change();

        var buffering_set_motor = [],
            buffer_delay = false;
        $('div.sliders input:not(.master)').on('input', function () {
            var index = $(this).index(),
                buffer = [];

            $('div.values li').eq(index).text($(this).val());

            for (var i = 0; i < 8; i++) {
                var val = parseInt($('div.sliders input').eq(i).val());
                buffer.push16(val);
            }

            buffering_set_motor.push(buffer);

            if (!buffer_delay) {
                buffer_delay = setTimeout(function () {
                    buffer = buffering_set_motor.pop();

                    MSP.send_message(MSPCodes.MSP_SET_MOTOR, buffer);

                    buffering_set_motor = [];
                    buffer_delay = false;
                }, 10);
            }
        });

        $('div.sliders input.master').on('input', function () {
            var val = $(this).val();

            $('div.sliders input:not(:disabled, :last)').val(val);
            $('div.values li:not(:last)').slice(0, number_of_valid_outputs).text(val);
            $('div.sliders input:not(:last):first').trigger('input');
        });

        // check if motors are already spinning
        var motors_running = false;

        for (var i = 0; i < number_of_valid_outputs; i++) {
            if (!self.feature3DEnabled) {
                if (MOTOR_DATA[i] > rangeMin) {
                    motors_running = true;
                }
            } else {
                if ((MOTOR_DATA[i] < MOTOR_3D_CONFIG.deadband3d_low) || (MOTOR_DATA[i] > MOTOR_3D_CONFIG.deadband3d_high)) {
                    motors_running = true;
                }
            }
        }

        if (motors_running) {
            $('#motorsEnableTestMode').prop('checked', true).change();

            // motors are running adjust sliders to current values

            var sliders = $('div.sliders input:not(.master)');

            var master_value = MOTOR_DATA[0];
            for (var i = 0; i < MOTOR_DATA.length; i++) {
                if (MOTOR_DATA[i] > 0) {
                    sliders.eq(i).val(MOTOR_DATA[i]);

                    if (master_value != MOTOR_DATA[i]) {
                        master_value = false;
                    }
                }
            }

            // only fire events when all values are set
            sliders.trigger('input');

            // slide master slider if condition is valid
            if (master_value) {
                $('div.sliders input.master').val(master_value)
                    .trigger('input');
            }
        }

        function get_status() {
            // status needed for arming flag
            MSP.send_message(MSPCodes.MSP_STATUS, false, false, get_motor_data);
        }

        function get_motor_data() {
            MSP.send_message(MSPCodes.MSP_MOTOR, false, false, get_motor_telemetry_data);
        }

        function get_motor_telemetry_data() {
            if (MOTOR_CONFIG.use_dshot_telemetry || MOTOR_CONFIG.use_esc_sensor) {
                MSP.send_message(MSPCodes.MSP_MOTOR_TELEMETRY, false, false, get_servo_data);
            } else {
                get_servo_data();
            }
        }

        function get_servo_data() {
            MSP.send_message(MSPCodes.MSP_SERVO, false, false, update_ui);
        }

        GUI.content_ready(callback);
    }

    /////////////////////////////////////////////////////////////////////////////////////////////////////////

    function print_head() {
        var head = "timestamp";

        for (var i = 0; i < requested_properties.length; i++) {
            switch (requested_properties[i]) {
                case 'MSP_RAW_IMU':
                    head += ',' + 'gyroscopeX';
                    head += ',' + 'gyroscopeY';
                    head += ',' + 'gyroscopeZ';

                    head += ',' + 'accelerometerX';
                    head += ',' + 'accelerometerY';
                    head += ',' + 'accelerometerZ';

                    head += ',' + 'magnetometerX';
                    head += ',' + 'magnetometerY';
                    head += ',' + 'magnetometerZ';
                    break;
                case 'MSP_ATTITUDE':
                    head += ',' + 'kinematicsX';
                    head += ',' + 'kinematicsY';
                    head += ',' + 'kinematicsZ';
                    break;
                case 'MSP_ALTITUDE':
                    head += ',' + 'altitude';
                    break;
                case 'MSP_RAW_GPS':
                    head += ',' + 'gpsFix';
                    head += ',' + 'gpsNumSat';
                    head += ',' + 'gpsLat';
                    head += ',' + 'gpsLon';
                    head += ',' + 'gpsAlt';
                    head += ',' + 'gpsSpeed';
                    head += ',' + 'gpsGroundCourse';
                    break;
                case 'MSP_ANALOG':
                    head += ',' + 'voltage';
                    head += ',' + 'amperage';
                    head += ',' + 'mAhdrawn';
                    head += ',' + 'rssi';
                    break;
                case 'MSP_RC':
                    for (var chan = 0; chan < RC.active_channels; chan++) {
                        head += ',' + 'RC' + chan;
                    }
                    break;
                case 'MSP_MOTOR':
                    for (var motor = 0; motor < MOTOR_DATA.length; motor++) {
                        head += ',' + 'Motor' + motor;
                    }
                    break;
                case 'MSP_DEBUG':
                    for (var debug = 0; debug < SENSOR_DATA.debug.length; debug++) {
                        head += ',' + 'Debug' + debug;
                    }
                    break;
            }
        }

        append_to_file(head);
    }

    function crunch_data() {
        var sample = millitime();

        for (var i = 0; i < requested_properties.length; i++) {
            switch (requested_properties[i]) {
                case 'MSP_RAW_IMU':
                    sample += ',' + SENSOR_DATA.gyroscope;
                    sample += ',' + SENSOR_DATA.accelerometer;
                    sample += ',' + SENSOR_DATA.magnetometer;
                    break;
                case 'MSP_ATTITUDE':
                    sample += ',' + SENSOR_DATA.kinematics[0];
                    sample += ',' + SENSOR_DATA.kinematics[1];
                    sample += ',' + SENSOR_DATA.kinematics[2];
                    break;
                case 'MSP_ALTITUDE':
                    sample += ',' + SENSOR_DATA.altitude;
                    break;
                case 'MSP_RAW_GPS':
                    sample += ',' + GPS_DATA.fix;
                    sample += ',' + GPS_DATA.numSat;
                    sample += ',' + (GPS_DATA.lat / 10000000);
                    sample += ',' + (GPS_DATA.lon / 10000000);
                    sample += ',' + GPS_DATA.alt;
                    sample += ',' + GPS_DATA.speed;
                    sample += ',' + GPS_DATA.ground_course;
                    break;
                case 'MSP_ANALOG':
                    sample += ',' + ANALOG.voltage;
                    sample += ',' + ANALOG.amperage;
                    sample += ',' + ANALOG.mAhdrawn;
                    sample += ',' + ANALOG.rssi;
                    break;
                case 'MSP_RC':
                    for (var chan = 0; chan < RC.active_channels; chan++) {
                        sample += ',' + RC.channels[chan];
                    }
                    break;
                case 'MSP_MOTOR':
                    sample += ',' + MOTOR_DATA;
                    break;
                case 'MSP_DEBUG':
                    sample += ',' + SENSOR_DATA.debug;
                    break;
            }
        }

        log_buffer.push(sample);
    }

    // IO related methods
    var fileEntry = null,
        fileWriter = null;

    function prepare_file() {

        var prefix = 'log';
        var suffix = 'csv';

        var filename = generateFilename(prefix, suffix);

        var accepts = [{
            description: suffix.toUpperCase() + ' files', extensions: [suffix],
        }];

        // create or load the file
        chrome.fileSystem.chooseEntry({ type: 'saveFile', suggestedName: filename, accepts: accepts }, function (entry) {
            if (!entry) {
                console.log('No file selected');
                return;
            }

            fileEntry = entry;

            // echo/console log path specified
            chrome.fileSystem.getDisplayPath(fileEntry, function (path) {
                console.log('Log file path: ' + path);
            });

            // change file entry from read only to read/write
            chrome.fileSystem.getWritableEntry(fileEntry, function (fileEntryWritable) {
                // check if file is writable
                chrome.fileSystem.isWritableEntry(fileEntryWritable, function (isWritable) {
                    if (isWritable) {
                        fileEntry = fileEntryWritable;

                        // save entry for next use
                        ConfigStorage.set({ 'logging_file_entry': chrome.fileSystem.retainEntry(fileEntry) });

                        // reset sample counter in UI
                        $('.samples').text(0);

                        prepare_writer();
                    } else {
                        console.log('File appears to be read only, sorry.');
                    }
                });
            });
        });
    }

    function prepare_writer(retaining) {
        fileEntry.createWriter(function (writer) {
            fileWriter = writer;

            fileWriter.onerror = function (e) {
                console.error(e);

                // stop logging if the procedure was/is still running
                if ($('a.logging').data('clicks')) $('a.logging').click();
            };

            fileWriter.onwriteend = function () {
                $('.size').text(bytesToSize(fileWriter.length));
            };

            if (retaining) {
                chrome.fileSystem.getDisplayPath(fileEntry, function (path) {
                    GUI.log(i18n.getMessage('loggingAutomaticallyRetained', [path]));
                });
            }

            // update log size in UI on fileWriter creation
            $('.size').text(bytesToSize(fileWriter.length));
        }, function (e) {
            // File is not readable or does not exist!
            console.error(e);

            if (retaining) {
                fileEntry = null;
            }
        });
    }

    function append_to_file(data) {
        if (fileWriter.position < fileWriter.length) {
            fileWriter.seek(fileWriter.length);
        }

        fileWriter.write(new Blob([data + '\n'], { type: 'text/plain' }));
    }
};

TABS.logging.cleanup = function (callback) {
    if (callback) callback();
};
