const express = require("express"); // from npm registry
const Fetch = require("node-fetch"); // from npm registry
const https = require("https"); // built-in
const api = express();

if (process.env.npm_package_config_port === undefined) {
    console.error("Please run this package with `npm start`");
    process.exit(1);
}

const send_hook = (msg) => {
    Fetch(process.env.npm_package_config_logger_webhook, {
        method: "POST",
        cache: "no-cache",
        redirect: "follow",
        headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            content: msg,
        }),
    });

    console.log(msg);
};

const logger = {
    log: msg => send_hook(`${msg}`),
    info: msg => send_hook(`ℹ ${msg}`),
    warn: msg => send_hook(`⚠ ${msg}`),
    error: msg => send_hook(`❌ ${msg}`),
};

// config common to all routers:
api.locals = Object.assign({
    rate_limiting: new Set(), // XXX: or do we want routers to each have their own rate limiter?
    mailer: {
        from: process.env.npm_package_config_mailer_from,
    },
    logger: logger,
}, api.locals);



/*******************************
    BEGIN MIDDLEWARES
********************************/

const checkRateLimiting = (req, res, next) => {
    if (req.app.locals.rate_limiting.has(req.ip)) {
        res.status(429).json({
            status: "error",
            error: "too many requests"
        });
    } else {
        next();
    }
    return;
};

const checkCaptcha = (req, res, next) => {
    const token = String(req.get("X-CAPTCHA-TOKEN") || "");

    if (!token.match(/^[a-zA-Z0-9-_]{20,800}$/)) {
        res.status(403).json({
            status: "error",
            error: "no token sent"
        });
        req.app.locals.rate_limiting.add(req.ip);
        setTimeout(() => req.app.locals.rate_limiting.delete(req.ip), 300000);
        return false;
    }

    https.get(`https://www.google.com/recaptcha/api/siteverify?secret=${process.env.npm_package_config_recaptcha_secret}&response=${token}`, re => {
        re.setEncoding("utf8");
        re.on("data", response => {
            const data = JSON.parse(response);
            if (!Reflect.has(data, "success") || data.success !== true) {
                if (Reflect.has(data, "error-codes")) {
                    const error_codes = data["error-codes"].toString();
                    if (error_codes !== "invalid-input-response") {
                        console.error("reCAPTCHA returned an error: %s", error_codes);
                    }
                }
                res.status(403).json({
                    status: "error",
                    error: "captcha validation failed"
                });
                req.app.locals.rate_limiting.add(req.ip);
                setTimeout(() => req.app.locals.rate_limiting.delete(req.ip), 300000);
                return false;
            }

            next(); // challenge passed, so process the request
        });
    }).on("error", error => {
        console.error(error);
        res.status(403).json({
            status: "error",
            error: "reCAPTCHA couldn't be reached"
        });
        console.warn("reCAPTCHA couldn't be reached");
        return false;
    })
};

/*******************************
    END MIDDLEWARES
********************************/



/*******************************
    BEGIN ROUTERS
********************************/

const global_router = express.Router(["caseSensitive", "strict"]);

const tmwa_router = new (require("./routers/tmwa"))({
    timezone: process.env.npm_package_config_timezone,
    name: process.env.npm_package_config_tmwa_name,
    url: process.env.npm_package_config_tmwa_url,
    root: process.env.npm_package_config_tmwa_root,
    home: process.env.npm_package_config_tmwa_home,
}, api, checkCaptcha, checkRateLimiting);

global_router.use("/tmwa", tmwa_router);
api.use("/api", global_router);

/*******************************
    END ROUTERS
********************************/



// default endpoint:
api.use((req, res, next) => {
    res.status(404).json({
        status: "error",
        error: "unknown endpoint"
    });
});

api.set("trust proxy", "loopback"); // only allow localhost to communicate with the API
api.disable("x-powered-by"); // we don't need this header
api.listen(process.env.npm_package_config_port, () => console.info("Listening on port %d", process.env.npm_package_config_port));
