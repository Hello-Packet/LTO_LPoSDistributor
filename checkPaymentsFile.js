/**
 * Put your mandatory setting here:
 *     - node: address of your node in the form http://<ip>:<port
 */

var config = {
    payoutfileprefix: 'ltoleaserpayouts',
    node: 'enter node api address',	//Change this value to your blockchain node
    paymentqueuefile: 'payqueue.dat'
};

var fs = require('fs');
var request = require('request');
var os = require('os');

var payments;
var payjobs;
var payjobcounter = 0;
var assetsumarray = {};
var assetamount = 0;
var allbatchsinglecost = 0
var allbatchmasstxcost = 0

const transferfee = 25000000
const masstransferfee = 10000000;
const maxmasstransfertxs = 100 //Maximum nr of transactions that fit in 1 masstransfer

//This function rounds a number up to the nearest upper number
//i.e. number is 230000, upper is 100000 -> 300000
//i.e. number is 180000, upper is 100000 -> 200000
//@params number: the number to normalize
//@params upper: the nearest upper number for roundup
function roundup(number, upper) {

  var i = number - upper

  while (i > upper) {
    i -= upper
  }
  var delta = upper - i
  number += delta
  return number
}

//This function is started first in main program
//It executes some test cases before main start() runs
function ifstart() {

  if (!fs.existsSync(config.paymentqueuefile)) {
    console.log("Paymentqueue file '" + config.paymentqueuefile + "' not found. Start a collector session first and then try again.")
  } else {
    paymentids = JSON.parse(fs.readFileSync(config.paymentqueuefile))
    if (paymentids.length == 0) {
      console.log("The paymentqueue is empty, no payments to check");
    }
    else {
      start();
    }
  }
}


// Method that starts the checking process
// - Find all pending paymentIDs from paymentqueue file
// - For every corresponding payout files check the payments
var checkallpendingpayouts = function () {

  var batchid;	//Number of the paymentbatch that is stored in the queue file
  var payqueuearray = JSON.parse(fs.readFileSync(config.paymentqueuefile));	//read the payqueue file with all payoutjobs
  var payoutfilenameprefix;
  var timeout = 0;
  payjobs = parseInt(payqueuearray.length)

  console.log("\nFound " + payqueuearray.length + " pending pay jobs in the queue file.\n"
    + "=============================================================================================");

  payqueuearray.forEach(function (batchid, index) {  //remark: index in array starts at 0!

    var jobid = parseInt(index) + 1		//Sequencial jobnr just for nice screen presentation
    payoutfilenameprefix = config.payoutfileprefix + batchid
    payoutfilename = payoutfilenameprefix + ".json"		//Filename where all paymentinfo is stored
    timeout = parseInt(index) * 50;

    // Start function that checks the payoutcontents for the batchid
    setTimeout(checkpayouts, timeout, payoutfilename, batchid, jobid);

  });
}


// This is the main function that is called from main program part
var start = function () {
  checkallpendingpayouts();
}


// This function does the actual payment checks in the payoutfile
// - arg filename: the payoutfile name to be checked
// - batchid: paymentid for job
// - jobnr: sequence nr of all jobs (starts at 1)

var blocks = 0

function checkpayouts(filename, batchid, jobnr) {

  var assets = {};
  var assetsFound = 0;
  var paymentsString = fs.readFileSync(filename).toString();
  payments = JSON.parse(paymentsString);
  var addmessage;
  var message = "Job " + jobnr + ", batch ID " + batchid + ", payoutfile '" + filename + "'. "
  payjobcounter++

  // Read logfile for current batch and get the blocks that were forged
  function getblocksforged() {
    var batchlogfile = config.payoutfileprefix + batchid + '.log'
    var batchlogarray = (fs.readFileSync(batchlogfile).toString()).split(os.EOL)
    var forgedblocksstring = batchlogarray.find(a => a.includes("forged:"));
    blocks += parseInt(forgedblocksstring.substring(forgedblocksstring.indexOf(":") + 1, forgedblocksstring.length))
    return forgedblocksstring
  }

  function constructassetsarray() {

    payments.forEach(function (payment) {		//For every json set { } found, which marks 1 payment

      if (!assets['lto']) {		//First time found -> not in var assets {} yet
        assetsFound++;		//Increase var assetFound with 1
        assets['lto'] = {	//Set lto string in asset array
          batchid: batchid,
          amount: payment.amount,	//set amount from payment {} to lto.amount in assets array
          transactions: 1, //Set counter on first transaction
          decimals: 8,
          name: 'lto'	//set name key to 'lto' in assets array
        };
      } else {			//lto bestaat al in assets array
        assets['lto'].amount += payment.amount;	//Increase the amount with next payment {} amount
        assets['lto'].transactions++ //Increase counter lto transactons
      }
    });	//End forEach

    if (payments.length == 0) {	//Payout file IS empty, no payouts needed

      addmessage = 'Nothing to pay! ' + getblocksforged()

    } else {	//Payout file is NOT empty, let's dig up amount and asset info

      addmessage = payments.length + ' payments. ' + getblocksforged()
    }


    /**
     * Method that adds infor like decimals and name to an asset.
     *
     * @param assets The asset that have been found
     * @param cb The callback that gets executed after all infos are added
     */
    var addAssetInfo = function (assets, cb) {
      var counter = 0;

      for (var assetId in assets) {
        if (assetId !== 'lto') {
          request.get(config.node + '/transactions/info/' + assetId, function (err, response, body) {
            if (!err) {
              var asset = JSON.parse(body);

              counter++;
              assets[asset.assetId].decimals = asset.decimals;
              assets[asset.assetId].name = asset.name;

              if (assetsFound - 1 === counter) {
                cb();
              }
            }
          });
        } else {
          cb();
        }
      } //End for
    }; //End var addAssetInfo

    console.log(message + addmessage);

    addAssetInfo(assets, function () {	//assets is the array filled with the total amounts for all assetIds

      var singletransactions = 0
      var masstransfers = 0
      var singletxscosts = 0
      var masstransfercosts = 0
      var totalmasstransfers = 0
      var i = 0

      for (var assetId in assets) {	//For every asset found in one batch

        var asset = assets[assetId];
        singletransactions += asset.transactions //increase transactioncounter for single transactions
        masstransfers = Math.ceil(asset.transactions / maxmasstransfertxs) //how many masstransfers for one asset

        if (masstransfers == 1) { //Only 1 masstransfer needed

          var transfercost = transferfee + masstransferfee * asset.transactions
          masstransfercosts += transfercost

        } else { //More than 1 masstransfer needed

          var lasttxs = asset.transactions - (masstransfers - 1) * maxmasstransfertxs //How many transactions in last masstransfer
          var lastmasstxscost = transferfee + masstransferfee * lasttxs //Cost for last masstransfer
          masstransfercosts += lastmasstxscost

          //How much is the cost for a masstransfers, other then the last
          var transfercost = transferfee + masstransferfee * maxmasstransfertxs
          masstransfercosts += (transfercost * (masstransfers - 1)) //Cost for all masstransfers (except last)
        }

        totalmasstransfers += masstransfers

        i++	//Counter to know when we reached the end of the for loop
        console.log("    " + jobnr + ": " + (asset.amount / Math.pow(10, asset.decimals)) + ' of ' + asset.name + ' will be paid!');

        if (!assetsumarray[asset.name]) {	//This asset is not in the Array yet
          assetsumarray[asset.name] = {amount: asset.amount, decimals: asset.decimals}
        } else {
          assetsumarray[asset.name].amount += asset.amount	//Asset is found already, increase amount
        }

        if (assetsFound == i) { //Reached last asset
          console.log()	//Print empty line after last asset is returned in this  batch
          singletxscosts = singletransactions * transferfee / Math.pow(10, 8)
          masstransfercosts = masstransfercosts / Math.pow(10, 8)

          console.log("    " + jobnr + ": Cost involved with " + singletransactions + " single transactions: " + singletxscosts + " lto.")
          console.log("    " + jobnr + ": Cost involved with " + totalmasstransfers + " masstransfers: " + masstransfercosts + " lto.\n")

          allbatchsinglecost += singletxscosts
          allbatchmasstxcost += masstransfercosts

        }
      }
    });	//End function addAssetInfo

    if (payjobcounter == payjobs) {	//Reached end of payjob queue, print sum of all assets of all pending payment jobs
      setTimeout(function () {
        console.log("=============================================================================================\n" +
          "Finished checking all jobs in the payment queue. The total sum of all payouts will be;\n");

        if (JSON.stringify(assetsumarray) == '{}') {
          console.log("Nothing to pay.")
        } else {
          var i = 0;
          for (var assetid in assetsumarray) {
            var asset = assetsumarray[assetid];
            console.log(" - " + (asset.amount / Math.pow(10, asset.decimals)), assetid + " will be paid!");
            i++
          }
          console.log('\ntotal blocks: ' + blocks + '\n');
          console.log("Total lto transaction fee when single transactions would be used: " + allbatchsinglecost)
          console.log("Total lto transaction fee when masstransfers would be used: " + allbatchmasstxcost.toFixed(8) + "\n")

          if (allbatchmasstxcost < allbatchsinglecost) {
            console.log("It's cheapest to do the payouts with masstransfers. You save " +
              ((1 - allbatchmasstxcost / allbatchsinglecost) * 100).toFixed(1) + " percent.")
            console.log("To do masstransfers, use tool 'node masstx.js'.\n")
          } else if (allbatchmasstxcost == allbatchsinglecost) {
            console.log("Single transactions and masstransfers incur the same cost. Choose whichever you like;")
            console.log(" - for single transactions: 'node massPayment.js'")
            console.log(" - for masstransfers: 'node masstx.js'\n")
          } else {
            console.log("Single transactions are cheapest to do the payments.")
            console.log("To do single transactions, use tool 'node massPayment.js'\n")
          }
        }
      }, 150);
    }

  } //end function constructassetsarray

  constructassetsarray();

}	//End function checkpayouts

//Start Main program
ifstart();
