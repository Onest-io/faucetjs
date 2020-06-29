const express = require('express')
const router = express.Router()
const Onest = require('onsdex')
const level = require('level')
const JsonFile = require('jsonfile')
const config = JsonFile.readFileSync('./config.json')
const db = level('.faucet', {valueEncoding: 'json'})
const DbUtils = require('../modules/dbUtils')
const dbu = new DbUtils()
const crypto = require('crypto');

// db
// 0x - reserved for counters
// 1x - success registrations

let acc = null
let latestRegs = {}
let countRegs = 0
let registrar = null
let assetId = "1.3.0"
let referrer = "iobanker"

BitShares.connect(config.ons.node);
BitShares.subscribe('connected', startAfterConnected);

async function is_cheap_name(account_name) {
    return /[0-9-]/.test(account_name) || !/[aeiouy]/.test(account_name);
}

async function getReferrer(account_name) {
    let result = referrer
    let isLtm = false
    try {
        result = await BitShares.accounts[account_name]
        isLtm = result.id === result.lifetime_referrer
    } catch(e) {

    }
    if (!isLtm) {
        result = referrer
    }
    return result
}


async function startAfterConnected() {
    //acc = await Onest.login(config.ons.registrar, config.ons.password)
    console.log('-------------------------------------------------')
    acc = new BitShares(config.ons.registrar, config.ons.wif)

    registrar = await BitShares.accounts[config.ons.registrar]
    console.log('registrar', registrar.id, registrar.name)

    countRegs = await dbu.dbGet(db, '0xREG') || 0
    console.log('countRegs', countRegs)

    assetId = (await BitShares.assets[config.ons.core_asset]).id
    console.log('assetId', assetId, config.ons.core_asset)

    referrer = await BitShares.accounts[config.ons.default_referrer]

    console.log('default referrer', referrer.id, referrer.name)
    console.log('premium names', config.ons.allowPremium)
    console.log('-------------------------------------------------')
}

async function registerAccount(options, ip) {
    let userReferrer = referrer
    let isAllowReg = true
    let result = {
        "status": "Error registration account",
        "account": {
            "name": null,
            "owner_key": null,
            "active_key": null,
            "memo_key": null,
        }
    }

    if (latestRegs[ip]) {
        let time = Math.floor(Date.now() / 1000) - config.ons.timeoutIp
        isAllowReg = time > latestRegs[ip].time
        //console.log('hold sec', latestRegs[ip].time - time)
    }

    if (!isAllowReg) {
        result = {"error": {"base": ["Only one account per IP " + config.ons.timeoutIp / 60 + " min"]}}
        return result
    }

    latestRegs[ip] = {
        time: Math.floor(Date.now() / 1000),
        name: options.name,
    }

    if (options.referrer && config.ons.allowCustomerReferer) {
        userReferrer = await getReferrer(options.referrer)
    }

    if (config.ons.broadcastTx && isAllowReg) {
        let params = {
            fee: {amount: 0, asset_id: assetId},
            name: options.name,
            registrar: registrar.id,
            referrer: userReferrer.id,
            referrer_percent: config.ons.referrer_percent * 100,
            owner: {
                weight_threshold: 1,
                account_auths: [],
                key_auths: [[options.owner, 1]],
                address_auths: []
            },
            active: {
                weight_threshold: 1,
                account_auths: [],
                key_auths: [[options.active, 1]],
                address_auths: []
            },
            options: {
                memo_key: options.memo,
                voting_account: registrar.id,
                num_witness: 0,
                num_committee: 0,
                votes: []
            },
            extensions: []
        };
        try {
            let tx = acc.newTx()
            tx.account_create(params)
            await tx.broadcast()
            result = {
                "status": "Account created",
                "account": {
                    "name": options.name,
                    "owner_key": options.owner,
                    "active_key": options.active,
                    "memo_key": options.memo,
                }
            }
            await db.put('1x' + options.name, {
                "name": options.name,
                "time": Math.floor(Date.now() / 1000),
            })
            countRegs++
            await db.put('0xREG', countRegs)


        } catch (e) {
            //console.log('e', e)
            result = {"error": {"base": ["Error registration new account."]}}
        }
    } else {
        result = {"error": {"base": ["Broadcast Tx off"]}}
    }
    return result
}

//test ip
router.get('/v1/ip', async function (req, res, next) {
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    await res.json({
        ip: ip,
    })
})

router.get('/v1/latest', async function (req, res, next) {
    await res.json(latestRegs)
})

router.post('/v1/accounts', async function (req, res, next) {
    let ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    let hashIp = crypto.createHash('md5').update(ip).digest("hex");
    // console.log('ip', ip, hashIp)
    let result = false
    let err = false
    let name = (req.body.account.name).toLowerCase()
    if (!config.ons.allowPremium) {
        err = !(await is_cheap_name(name)) // is not cheap name = true
    }
    if (req.body.account && !err) {
        result = await registerAccount({
            name: name,
            owner: req.body.account.owner_key,
            active: req.body.account.active_key,
            memo: req.body.account.memo_key,
            referrer: req.body.account.referrer,
        }, hashIp)
    } else {
        result = {"error": {"base": ["Only standard accounts names allowed"]}}
    }
    await res.json(result)
});

router.get('/v1/registrations', async function (req, res, next) {
    await res.json({
        total: await dbu.dbGet(db, '0xREG') || 0,
        accounts: await dbu.dbArray(db, '1', '2')
    })
})

router.get('/v1/counter', async function (req, res, next) {
    await res.json({
        registrations: await dbu.dbGet(db, '0xREG') || 0,
    })
})

module.exports = router;
