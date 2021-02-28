/*
 * vi:set sw=4 noet:
 *
 * MIT License
 *
 * Original work Copyright (c) 2018 Phillip Moon
 * Modified work Copyright 2019 Jay Schuster
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

var Service, Characteristic;
const tough = require('tough-cookie');
const got = require("got");

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerPlatform("homebridge-lacrosseweb", "LacrosseWeb", LacrosseWeb);
};

/*
 * Platform code
 */
function LacrosseWeb(log, config) {
    this.log = log;
    this.config = config;
    this.log.debug("LacrosseWeb(log, config) called.");
    this.parseJSON = s => {
	try {
	    return JSON.parse(s);
	} catch (error) { }
	return false;
    };
}

LacrosseWeb.prototype = {
    accessories: function (callback) {
	this.log.debug("LacrosseWeb.accessories(callback) called.");
	const config = this.config;
	this.apiBaseURL = config["apiBaseURL"] || "http://lacrossealertsmobile.com/v1.2";
	this.apiBaseURL = this.apiBaseURL.lastIndexOf("/") == this.apiBaseURL.length - 1 ? this.apiBaseURL : this.apiBaseURL + "/";
	this.username = config["username"];
	this.password = config["password"];
	this.configCacheSeconds = config["configCacheSeconds"] || 30;
	this.noResponseMinutes = config["noResponseMinutes"] || 30;
	this.accessories = [];
	this.deviceDictionary = {};
	this.lastLogin = null;
	this.loggedIn = false;
	this.refreshConfigInProgress = false;
	this.cookieJar = new tough.CookieJar();
	this.got = got.extend({
	    prefixUrl: this.apiBaseURL,
	    resolveBodyOnly: true,
	    headers: {
		// 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15'
		'user-agent': undefined
	    }
	});
	this.setupAccessories = function (accessories) {
	    this.log("Setting up accessories/devices...");
	    callback(accessories);
	};
	this.instantiateAccessories();
    },

    doLogin: async function () {
	this.log.debug("LacrosseWeb.doLogin() called.");
	// Get the account information page, and grab some values from it.
	var body = await this.got
	    .get("resources/js/dd/account-enhanced.js?ver=11", {cookieJar: this.cookieJar})
	    .catch((err) => {
		this.log("GET /login", err.name, err.response ? err.response.statusCode : "");
		return(null);
	    });
	if (!body) {
	    this.log("Login failed. Giving up.");
	    this.loggedIn = false;
	    return this.loggedIn;
	}
	this.log.debug("GET /login OK");
	const prodKey = body.match(/var\s+prodKey\s*=\s*"([^"]+)"/m)[1];
	const serviceURL = body.match(/var\s+serviceURL\s*=[^"]*"([^"]+)"/m)[1];
	const matches = body.match(/setCookie\(\s*"([^"]+)"\s*,\s*response\.sessionKey\s*,\s*(\d+)/m);
	const cookieName = matches[1];
	const cookieExpYears = matches[2];
	// Authenticate, which returns the session key.
	const subURL = 'https:' + serviceURL + 'user-api.php?pkey=' + prodKey + '&action=userlogin';
	body = await this.got
	    .post({
		    url: subURL,
		    form: {
			iLogEmail: this.username,
			iLogPass: this.password
		    }
		},
		{cookieJar: this.cookieJar}
	    )
	    .catch((err) => {
		this.log("POST /login", err.name, err.response ? err.response.statusCode : "");
		return err.response && 302 == err.response.statusCode ? err.response.body : null;
	    });
	if (!body) {
	    this.log("Login failed. Giving up.");
	    this.loggedIn = false;
	    return false;
	}
	this.lastLogin = new Date().getTime();
	body = this.parseJSON(body);
	if (!body || !body.sessionKey) {
	    this.log("Didn't get a session key. Giving up.");
	    this.log(body);
	    this.loggedIn = false;
	    return false;
	}
	// Set the cookie based on the session key.
	//
	// Note: The session key never changes. Once you
	// know it, you don't ever need to retrieve it again.
	const domain = this.apiBaseURL.match(/:\/\/([^\/]*)\//)[1];
	const cookie = cookieName + '=' + body.sessionKey + '; Max-Age=' + (cookieExpYears*365*24*60*60) + '; Domain=' + domain + '; Path=/';
	this.cookieJar.setCookieSync(cookie, this.apiBaseURL);
	// Done
	this.loggedIn = true;
	return true;
    },

    getStatus: async function () {
	this.log.debug("LacrosseWeb.getStatus() called.");
	var body = await this.got
	    .get("", {cookieJar: this.cookieJar})
	    .catch((err) => {
		this.log("GET /", err.name, err.response ? err.response.statusCode : "");
		this.log(err);
		return null;
	    });
	if (!body) {
	    this.loggedIn = false;
	    return null;  // Error. Not sure what to do. Try logging in again.
	}
	else if (!body.match(/^userProviderID = /m)) {
	    this.log("getStatus(): Didn't get state information");
	    this.log(body);
	    this.loggedIn = false;
	    return null;  // Didn't get state information; try logging in again.
	}
	this.log.debug("GET / OK");
	return body;
    },

    getConfig: async function () {
	this.log.debug("LacrosseWeb.getConfig() called.");
	var body;
	while (!body) {
	    if (!this.loggedIn && !await this.doLogin()) {
		return null;
	    }
	    body = await this.getStatus();
	}
	// We're logged in and have retrieved the status page. Parse it.
	const matches = body.match(/^userProviderID\s=\s(\d+);userGatewaysList\s=\s'(\d+)';var\sisMetric\s=\s(\d);var\sdevicesInitData\s=\s(.*}});var\srefreshInt/m);
	if (!matches) {
	    this.log("getConfig: matching FAILED");
	    this.log(body);
	    return null;
	}
	const userProviderID = parseInt(matches[1], 10);
	const userGatewaysList = matches[2];
	const isMetric = parseInt(matches[3], 10);
	const devicesInitData = this.parseJSON(matches[4]);
	if (!devicesInitData) {
	    this.log("getConfig JSON parsing FAILED:", matches[4]);
	    return null;
	}
	this.lastConfigFetch = new Date().getTime();
	// Parse devicesInitData into devices.
	var devices = [ ];
	for (const key in devicesInitData) {
	    const dev = devicesInitData[key];
	    const obs = dev.obs[0];
	    if (this.lastConfigFetch > obs.u_timestamp * 1000) {
		this.lastConfigFetch = obs.u_timestamp * 1000;
	    }
	    devices.push({
		device_id: dev.device_id,
		name: dev.device_name,
		timestamp: obs.u_timestamp,
		services: {
		    ambientTemp: {
			service_name: "ambientTemp",
			rawvalue: obs.ambient_temp,
			value: isMetric
				? obs.ambient_temp
				: (obs.ambient_temp - 32) * 5/9
		    },
		    probeTemp: {
			service_name: "probeTemp",
			rawvalue: obs.probe_temp,
			value: isMetric
				? obs.probe_temp
				: (obs.probe_temp - 32) * 5/9
		    },
		    currentRH: {
			service_name: "currentRH",
			value: obs.humidity,
		    },
		    lowBatt: {
			service_name: "lowBatt",
			value: obs.lowbattery
		    }
		}
	    });
	}
	if (0 == devices.length) {
	    this.log("getConfig FAILED");
	    this.log(body);
	    return null;
	}
	this.log.debug("getConfig:");
	this.log.debug(JSON.stringify(devices, null, 2));
	return devices;
    },

    instantiateAccessories: async function () {
	var devices = await this.getConfig();
	if (!devices || devices.length == 0) {
	    this.log("Malformed config, skipping.");
	    return;
	}
	for (let i = 0, l = devices.length; i < l; i++) {
	    let device = devices[i];
	    let name = device.name;
	    if (!name) {
		this.log("Device had no name, not added:");
		this.log(JSON.stringify(device));
		continue;
	    }
	    else if (this.deviceDictionary[name]) {
		this.log(`"${name}" already instantiated.`);
	    }
	    else {
		this.deviceDictionary[name] = new LacrosseWebDevice(this.log, device, this);
		this.accessories.push(this.deviceDictionary[name]);
		this.log(`Added "${name}" - Device ID: ${device.device_id}.`);
	    }
	}
	this.setupAccessories(this.accessories);
    },

    refreshConfig: async function (msg) {
	if (this.lastConfigFetch && (new Date().getTime() - this.lastConfigFetch) / 1000 <= this.configCacheSeconds) {
	    this.log.debug(`${msg}: Using cached data; less than ${this.configCacheSeconds}s old.`);
	    return;
	}
	if (this.refreshConfigInProgress) {
	    this.log.debug(`${msg}: Refresh in progress.`);
	    return;
	}
	this.refreshConfigInProgress = true;
	this.log.debug(`${msg}: Refreshing.`);
	var devices = await this.getConfig();
	if (!devices) {
	    this.log(`${msg}: Refresh FAILED.`);
	    this.refreshConfigInProgress = false;
	    return;
	}
	this.log.debug(`${msg}: Refresh successful.`);
	for (var i = 0, l = devices.length; i < l; i++) {
	    var device = devices[i];
	    var name = device.name;
	    if (!name || !this.deviceDictionary[name]) {
		continue;
	    }
	    var age = new Date().getTime()/1000 - device.timestamp;
	    if (age > 60 * this.noResponseMinutes) {
		this.log(`Data for ${name} are obsolete: ${age} seconds old`);
		device.services = null;
	    }
	    this.deviceDictionary[name].updateData(device);
	}
	this.refreshConfigInProgress = false;
    }
}

/*
 * Accessory code
 */
function LacrosseWebDevice(log, details, platform) {
    this.dataMap = {
	lowBatt: {
	    intesis: function (homekit) {
		let intesis;
		switch (homekit) {
		    case Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW:
			intesis = 1;
			break;
		    case Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL:
		    default:
			intesis = 0;
			break;
		}
		return intesis;
	    },
	    homekit: [
		Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
		Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
	    ]
	}
    }
    this.log = log;
    this.details = details;
    this.platform = platform;
    this.name = details.name;

    this.ambientTemperatureSensor = new Service.TemperatureSensor(details.name);
    this.ambientTemperatureSensor.subtype = "Ambient";
    this.ambientTemperatureSensor
	.getCharacteristic(Characteristic.CurrentTemperature)
	.setProps({
	    minValue: -100,
	    maxValue: 100,
	    description: "Ambient Temperature"
	});
    if (details.services.probeTemp.value) {
	this.probeTemperatureSensor = new Service.TemperatureSensor(details.name);
	this.probeTemperatureSensor.subtype = "Probe";
	this.probeTemperatureSensor
	    .getCharacteristic(Characteristic.CurrentTemperature)
	    .setProps({
		minValue: -100,
		maxValue: 100,
		description: "Probe Temperature"
	    });
    }
    else {
	this.probeTemperatureSensor = null;
    }

    this.humiditySensor = new Service.HumiditySensor(details.name);
    this.accessoryInfo = new Service.AccessoryInformation();
    this.accessoryInfo
	.setCharacteristic(Characteristic.Manufacturer, "Lacrosse")
	.setCharacteristic(Characteristic.Model, details.name)
	.setCharacteristic(Characteristic.SerialNumber, details.device_id);
    this.services = [this.ambientTemperatureSensor, this.humiditySensor, this.accessoryInfo];
    if (this.probeTemperatureSensor) {
	this.services.push(this.probeTemperatureSensor);
    }
    this.setup(this.details);
}

LacrosseWebDevice.prototype = {
    setup: function (details) {
	var services = details.services;
	var deviceID = details.device_id;
	for (var serviceName in services) {
	    this.addService(services[serviceName], deviceID);
	}
    },

    getServices: function () {
	return this.services;
    },

    updateData: function (newDetails) {
	if (!newDetails) {
	    return;
	}
	this.details = newDetails;
	for (var serviceData in newDetails.services) {
	    switch (serviceData.service_name) {
		case "ambientTemp":
		    this.ambientTemperatureSensor
			.updateCharacteristic(Characteristic.CurrentTemperature, serviceData.value);
		    break;
		case "probeTemp":
		    if (this.probeTemperatureSensor) {
			this.probeTemperatureSensor
			    .updateCharacteristic(Characteristic.CurrentTemperature, serviceData.value);
		    }
		    break;
		case "currentRH":
		    this.humiditySensor
			.updateCharacteristic(Characteristic.CurrentRelativeHumidity, serviceData.value);
		    break;
		case "lowBatt":
		    this.ambientTemperatureSensor
			.updateCharacteristic(Characteristic.StatusLowBattery, this.dataMap.lowBatt.homekit[serviceData.value]);
		    if (this.probeTemperatureSensor) {
			this.probeTemperatureSensor
			    .updateCharacteristic(Characteristic.StatusLowBattery, this.dataMap.lowBatt.homekit[serviceData.value]);
		    }
		    this.humiditySensor
			.updateCharacteristic(Characteristic.StatusLowBattery, this.dataMap.lowBatt.homekit[serviceData.value]);
		    break;
	    }
	}
    },

    addService: function (service, deviceID) {
	const serviceName = service.service_name;
	switch (serviceName) {
	    case "ambientTemp":
		this.ambientTemperatureSensor
		    .getCharacteristic(Characteristic.CurrentTemperature)
		    .on("get", callback => {
			this.platform.refreshConfig(`${this.name}: ${serviceName}`);
			this.details.services
			    ? callback(null, this.details.services.ambientTemp.value)
			    : callback(Error(), null);
		    })
		    .updateValue(this.details.services.ambientTemp.value);
		break;
	    case "probeTemp":
		if (this.probeTemperatureSensor) {
		    this.probeTemperatureSensor
			.getCharacteristic(Characteristic.CurrentTemperature)
			.on("get", callback => {
			    this.platform.refreshConfig(`${this.name}: ${serviceName}`);
			    this.details.services
				? callback(null, this.details.services.probeTemp.value)
				: callback(Error(), null);
			})
			.updateValue(this.details.services.probeTemp.value);
		}
		break;
	    case "currentRH":
		this.humiditySensor
		    .getCharacteristic(Characteristic.CurrentRelativeHumidity)
		    .on("get", callback => {
			this.platform.refreshConfig(`${this.name}: ${serviceName}`);
			this.details.services
			    ? callback(null, this.details.services.currentRH.value)
			    : callback(Error(), null);
		    })
		    .updateValue(this.details.services.currentRH.value);
		break;
	    case "lowBatt":
		this.ambientTemperatureSensor
		    .getCharacteristic(Characteristic.StatusLowBattery)
		    .on("get", callback => {
			this.platform.refreshConfig(`${this.name}: ${serviceName} ambientTemp`);
			this.details.services
			    ? callback(null, this.dataMap.lowBatt.homekit[this.details.services.lowBatt.value])
			    : callback(Error(), null);
		    })
		    .updateValue(this.dataMap.lowBatt.homekit[this.details.services.lowBatt.value]);
		if (this.probeTemperatureSensor) {
		    this.probeTemperatureSensor
			.getCharacteristic(Characteristic.StatusLowBattery)
			.on("get", callback => {
			    this.platform.refreshConfig(`${this.name}: ${serviceName} probeTemp`);
			    this.details.services
				? callback(null, this.dataMap.lowBatt.homekit[this.details.services.lowBatt.value])
				: callback(Error(), null);
			})
			.updateValue(this.dataMap.lowBatt.homekit[this.details.services.lowBatt.value]);
		}
		this.humiditySensor
		    .getCharacteristic(Characteristic.StatusLowBattery)
		    .on("get", callback => {
			this.platform.refreshConfig(`${this.name}: ${serviceName} currentRH`);
			this.details.services
			    ? callback(null, this.dataMap.lowBatt.homekit[this.details.services.lowBatt.value])
			    : callback(Error(), null);
		    })
		    .updateValue(this.dataMap.lowBatt.homekit[this.details.services.lowBatt.value]);
		break;
	}
    }
};
