# homebridge-lacrosseweb
Homebridge plugin for Lacrosse Alerts Mobile devices

## Overview

This is a Homebridge plugin for Lacrosse Alerts Mobile devices. It
scrapes the lacrossealertsmobile.com site to get the information it needs.

## Installation

With Homebridge already installed, install the plugin by running:
`npm install -g homebridge-lacrosseweb`

## Configuration

Here is an example stanza for your config.json:

    "platforms": [
      {
        "platform": "LacrosseWeb",
        "username": "username",
        "password": "password",
        "apiBaseURL": "http://lacrossealertsmobile.com/v1.2",
        "configCacheSeconds": 30
      }
    ]

### Required Options

* `platform` - Must be "LacrosseWeb".
* `username` - This is the username you use to log in to lacrossealertsmobile.com.
* `password` - This is the password you use to log in to lacrossealertsmobile.com.

### Optional Options

* `apiBaseURL` - The URL to the Lacrosse Alerts web site. Defaults to "http://lacrossealertsmobile.com/v1.2".
* `configCacheSeconds` - The number of seconds to cache the Lacrosse Alerts configuration for. This prevents the plugin from constantly scraping their website. The default value is 30.
