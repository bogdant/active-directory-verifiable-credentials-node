// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

// Verifiable Credentials Sample

///////////////////////////////////////////////////////////////////////////////////////
// Node packages
var express = require('express')
var session = require('express-session')
var base64url = require('base64url')
var secureRandom = require('secure-random');
var bodyParser = require('body-parser')
// mod.cjs
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const https = require('https')
const url = require('url')
const { SSL_OP_COOKIE_EXCHANGE } = require('constants');
var msal = require('@azure/msal-node');
const fs = require('fs');
const crypto = require('crypto');
var CDP = require('chrome-remote-interface');
const { PdfReader } = require('pdfreader');
const addressParser = require('parse-address');

var options = {
  key: fs.readFileSync('/etc/letsencrypt/live/carddium.com/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/carddium.com/cert.pem'),
  ca: fs.readFileSync('/etc/letsencrypt/live/carddium.com/chain.pem')
};


///////////////////////////////////////////////////////////////////////////////////////
// config file can come from command line, env var or the default
var configFile = process.argv.slice(2)[0];
if ( !configFile ) {
  configFile = process.env.CONFIGFILE || './config.json';
}
const config = require( configFile )
if (!config.azTenantId) {
  throw new Error('The config.json file is missing.')
}
module.exports.config = config;

///////////////////////////////////////////////////////////////////////////////////////
// MSAL
var msalConfig = {
  auth: {
      clientId: config.azClientId,
      authority: `https://login.microsoftonline.com/${config.azTenantId}`,
      clientSecret: config.azClientSecret,
  },
  system: {
      loggerOptions: {
          loggerCallback(loglevel, message, containsPii) {
              console.log(message);
          },
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Verbose,
      }
  }
};

// if certificateName is specified in config, then we change the MSAL config to use it
if ( config.azCertificateName !== '') {
  const privateKeyData = fs.readFileSync(config.azCertificatePrivateKeyLocation, 'utf8');
  console.log(config.azCertThumbprint);  
  const privateKeyObject = crypto.createPrivateKey({ key: privateKeyData, format: 'pem',    
    passphrase: config.azCertificateName.replace("CN=", "") // the passphrase is the appShortName (see Configure.ps1)    
  });
  msalConfig.auth = {
    clientId: config.azClientId,
    authority: `https://login.microsoftonline.com/${config.azTenantId}`,
    clientCertificate: {
      thumbprint: config.azCertThumbprint,
      privateKey: privateKeyObject.export({ format: 'pem', type: 'pkcs8' })
    }
  };
}

const cca = new msal.ConfidentialClientApplication(msalConfig);
const msalClientCredentialRequest = {
  scopes: ["3db474b9-6a0c-4840-96ac-1fceb342124f/.default"],
  skipCache: false, 
};
module.exports.msalCca = cca;
module.exports.msalClientCredentialRequest = msalClientCredentialRequest;

config.msIdentityHostName = "https://verifiedid.did.msidentity.com/v1.0/";

// Check if it is an EU tenant and set up the endpoint for it
fetch( `https://login.microsoftonline.com/${config.azTenantId}/v2.0/.well-known/openid-configuration`, { method: 'GET'} )
  .then(res => res.json())
  .then((resp) => {
    console.log( `tenant_region_scope = ${resp.tenant_region_scope}`);
    config.tenant_region_scope = resp.tenant_region_scope;
    // Check that the Credential Manifest URL is in the same tenant Region and throw an error if it's not
    if ( !config.CredentialManifest.startsWith(config.msIdentityHostName) ) {
      throw new Error( `Error in config file. CredentialManifest URL configured for wrong tenant region. Should start with: ${config.msIdentityHostName}` );
    }
  }); 
///////////////////////////////////////////////////////////////////////////////////////
// Main Express server function
// Note: You'll want to update port values for your setup.
const app = express()
const port = 443;

var parser = bodyParser.urlencoded({ extended: false });

//let client = CDP();
//const {Browser} = client;

global.PdfData = new Array();

fs.watch('/home/deejaybog/downloads', (event, filename) => {

  if(event === 'change' && filename.toLowerCase().endsWith('.pdf'))
  {
    console.log('PDF: '+filename);
    var pdf = new PdfReader();
    pdf.parseFileItems('/home/deejaybog/downloads/'+filename, (err, item) =>{
      if (err) console.error("error:", err);
      else if (!item) {
        console.warn("end of file");

        for(i=0; i<global.PdfData.length-2; i++){
          var fullAddress = global.PdfData[i+1]+ ' ' + global.PdfData[i+2];
          addr = addressParser.parseAddress(fullAddress);
          if(addr && addr.number && addr.state) {
            console.log("NAME FOUND: "+global.PdfData[i]);
            console.log("ADDRESS FOUND: "+fullAddress);
          }
        }
      }
      else if (item.text) {
        //console.log(item.text);
        global.PdfData.push(item.text);
      }
    });
  }

});

async function example() {
    let client;
    console.log('EXAMPLE START');
    try {
        // connect to endpoint
        client = await CDP();
        // extract domains
        const {Browser, Network, Page} = client;
        // setup handlers
        Network.requestWillBeSent((params) => {
//            console.log(params.request.url);
        });


	Browser.setDownloadBehavior({behavior:'allow',
		downloadPath:'/home/deejaybog/downloads',
		eventsEnabled:true});

	Browser.downloadWillBegin((params) =>
		{ console.log('BEGIN: '+params.url); });

        // enable events then start!
        await Network.enable();
        await Page.enable();
        //await Page.navigate({url: 'chrome://settings/content/pdfDocuments'});
        await Page.navigate({url: 'https://pse.com'});
        //await Page.navigate({url: 'https://firsttechfed.com'});
        await Page.loadEventFired();
    } catch (err) {
        console.error(err);
    } finally {
        if (client) {
//            await client.close();
        }
    }
}

example();

// Serve static files out of the /public directory
app.use(express.static('public'))
app.use('/.well-known', express.static('.well-known'))

// Set up a simple server side session store.
// The session store will briefly cache issuance requests
// to facilitate QR code scanning.
var sessionStore = new session.MemoryStore();
app.use(session({
  secret: 'cookie-secret-key',
  resave: false,
  saveUninitialized: true,
  store: sessionStore
}))

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Authorization, Origin, X-Requested-With, Content-Type, Accept");
  next();
});

module.exports.sessionStore = sessionStore;
module.exports.app = app;

function requestTrace( req ) {
  var dateFormatted = new Date().toISOString().replace("T", " ");
  var h1 = '//****************************************************************************';
  console.log( `${h1}\n${dateFormatted}: ${req.method} ${req.protocol}://${req.headers["host"]}${req.originalUrl}` );
  console.log( `Headers:`)
  console.log(req.headers);
}

// echo function so you can test that you can reach your deployment
app.get("/echo",
    function (req, res) {
        requestTrace( req );
        res.status(200).json({
            'date': new Date().toISOString(),
            'api': req.protocol + '://' + req.hostname + req.originalUrl,
            'Host': req.hostname,
            'x-forwarded-for': req.headers['x-forwarded-for'],
            'x-original-host': req.headers['x-original-host']
            });
    }
);

// Serve index.html as the home page
app.get('/', function (req, res) { 
  requestTrace( req );
  res.sendFile('public/index.html', {root: __dirname})
})

var verifier = require('./verifier.js');
var issuer = require('./issuer.js');

// start server
//app.listen(port, () => console.log(`Example issuer app listening on port ${port}!`))
https.createServer(options, app).listen(443)
