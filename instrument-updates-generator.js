'use strict'

const request = require('request-promise')
const _ = require('lodash')
const AWS = require('aws-sdk')
const winston = require('winston')
const arrayDiff = require('fast-array-diff')
const ejs = require('ejs')
const moment = require('moment')

const HOST_S3_BUCKET_NAME = process.env.HOST_S3_BUCKET_NAME
const GA_TRACKING_ID = process.env.GA_TRACKING_ID

const DATA_URL = 'https://randomcapital.hu/uploads/ik/basedata.json'
const INSTRUMENT_TYPES_TO_SAVE = [ 'Részvény', 'ETF', 'Pink Sheet' ]

const ISIN_CODE_REGEX = /^([A-Z]{2})[A-Z0-9]{9}\d{1}$/

const DATA_FILE_NAME = 'data.json'

const TEMPLATE_PATH_INSTRUMENT_UPDATES = './instrument-updates.ejs'

let s3Client = null

class InstrumentError extends Error {
  constructor(message, invalidElement) {
    super(message)

    this.name = `${ this.constructor.name }: ${ message }`
    this.invalidElement = invalidElement
  }
}

function LogFormatter(awsRequestId, options) {
  const { level, message: msg, meta } = options

  return JSON.stringify({
    level,
    msg,
    meta,
    awsRequestId,
  })
}

function createInstrument(instrumentRow) {
  return {
    ticker: instrumentRow[0],
    shortName: instrumentRow[1],
    longName: instrumentRow[2],
    isinCode: instrumentRow[3],
    type: instrumentRow[4],
  }
}

function instrumentSortCompare(a, b) {
  return (a.isinCode > b.isinCode) - (a.isinCode < b.isinCode)
}

async function getInstrumentsData() {
  winston.info('getInstrumentsData')
  try {
    return await request.get(DATA_URL)
  } catch (err) {
    throw new Error(`got non 200 response, error name: ${ err.name }, status code: ${ err.statusCode }`)
  }
}

function doParseAndValidation(body) {
  winston.info('doParseAndValidation')
  const parsedBody = JSON.parse(body)

  if (!_.isArray(parsedBody.data) || !parsedBody.data.length) {
    throw new InstrumentError('invalid data', parsedBody.data)
  }

  const instruments = parsedBody.data

  instruments.forEach(instrumentRow => {
    if (!_.isArray(instrumentRow) || instrumentRow.length < 5 || instrumentRow.length > 7) {
      throw new InstrumentError('invalid instrument row', instrumentRow)
    }

    const instrument = createInstrument(instrumentRow)

    if (!_.isString(instrument.ticker) || instrument.ticker.length < 1 || instrument.ticker.length > 12) {
      throw new InstrumentError('invalid instrument ticker', instrument.ticker)
    }
    if (!_.isString(instrument.shortName) || instrument.shortName.length < 2 || instrument.shortName.length > 24) {
      throw new InstrumentError('invalid instrument short name', instrument.shortName)
    }
    if (!_.isString(instrument.longName) || instrument.longName.length < 2 || instrument.longName.length > 64) {
      throw new InstrumentError('invalid instrument long name', instrument.longName)
    }
    if (!_.isString(instrument.isinCode) || !instrument.isinCode.match(ISIN_CODE_REGEX)) {
      throw new InstrumentError('invalid instrument ISIN code', instrument.isinCode)
    }
    if (!_.isString(instrument.type) || instrument.type.length > 24) {
      throw new InstrumentError('invalid instrument type', instrument.type)
    }
  })

  return instruments
}

function selectInstruments(instruments) {
  winston.info('selectInstruments')
  return instruments.filter(instrumentRow => INSTRUMENT_TYPES_TO_SAVE.indexOf(createInstrument(instrumentRow).type) !== -1)
}

async function doesDataFileExist() {
  winston.info('doesDataFileExist')
  const params = {
    Bucket: HOST_S3_BUCKET_NAME,
    Key: DATA_FILE_NAME,
  }
  try {
    await s3Client.headObject(params).promise()
    return true
  } catch (err) {
    if (err.code === 'NotFound') {
      return false
    }
    throw err
  }
}

function initDataFileToS3(instruments) {
  winston.info('initDataFileToS3')

  const data = {
    instruments: [],
    updates: [],
  }
  instruments.forEach(instrumentRow => {
    data.instruments.push(createInstrument(instrumentRow))
  })
  data.instruments.sort(instrumentSortCompare)

  const params = {
    Bucket: HOST_S3_BUCKET_NAME,
    Key: DATA_FILE_NAME,
    Body: JSON.stringify(data),
    ContentType: 'application/json; charset=utf-8',
  }
  return s3Client.putObject(params).promise()
}

function readDataFileFromS3() {
  winston.info('readDataFileFromS3')
  const params = {
    Bucket: HOST_S3_BUCKET_NAME,
    Key: DATA_FILE_NAME,
  }
  return s3Client.getObject(params).promise()
}

async function saveDataFileToS3(instrumentRows, dataFileBody) {
  winston.info('saveDataFileToS3')

  const instruments = []
  instrumentRows.forEach(instrumentRow => {
    instruments.push(createInstrument(instrumentRow))
  })
  instruments.sort(instrumentSortCompare)

  const dataFile = JSON.parse(dataFileBody.toString('utf-8'))
  dataFile.instruments.sort(instrumentSortCompare)

  const diff = arrayDiff.diff(dataFile.instruments, instruments, (a, b) => a.isinCode === b.isinCode)
  diff.removed.forEach(instrument => {
    dataFile.updates.push({
      type: 'removed',
      dateTime: new Date().toISOString(),
      instrument,
    })
  })
  diff.added.forEach(instrument => {
    dataFile.updates.push({
      type: 'added',
      dateTime: new Date().toISOString(),
      instrument,
    })
  })

  dataFile.instruments = instruments

  const params = {
    Bucket: HOST_S3_BUCKET_NAME,
    Key: DATA_FILE_NAME,
    Body: JSON.stringify(dataFile),
    ContentType: 'application/json; charset=utf-8',
  }
  await s3Client.putObject(params).promise()

  return dataFile.updates
}

function renderHtml(instrumentUpdates) {
  winston.info('renderHtml')

  const templateData = {
    gaTrackingId: GA_TRACKING_ID,
    generationDate: moment.utc().format('ll'),
    instrumentUpdates,
    formatDate: (date) => moment(date).format('ll'),
  }

  return new Promise((resolve, reject) => {
    ejs.renderFile(TEMPLATE_PATH_INSTRUMENT_UPDATES, templateData, (err, res) => {
      if (err) {
        reject(err)
      } else {
        resolve(res)
      }
    })
  })
}

function uploadInstrumentUpdatesToS3(html) {
  winston.info('uploadInstrumentUpdatesToS3')
  const params = {
    Bucket: HOST_S3_BUCKET_NAME,
    Key: 'instrument-updates.html',
    Body: html,
    ContentType: 'text/html; charset=utf-8',
  }
  return s3Client.putObject(params).promise()
}


async function Handler(event, context) {
  winston.remove(winston.transports.Console)
  winston.add(winston.transports.Console, {
    formatter: LogFormatter.bind(null, context.awsRequestId),
  })

  winston.info('starting', {
    nodeEnv: process.env.NODE_ENV,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    timezoneOffset: new Date().getTimezoneOffset() / 60,
    hostS3BucketName: HOST_S3_BUCKET_NAME,
    googleAnalyticsEnabled: GA_TRACKING_ID ? true : false,
  })

  s3Client = new AWS.S3()

  try {
    const instrumentsData = await getInstrumentsData()
    const instruments = doParseAndValidation(instrumentsData)
    const selectedInstruments = selectInstruments(instruments)

    let dataFile;
    if (await doesDataFileExist()) {
      dataFile = await readDataFileFromS3()
    } else {
      dataFile = await initDataFileToS3(selectedInstruments)
    }

    let instrumentUpdates;
    if (dataFile.Body) {
      instrumentUpdates = await saveDataFileToS3(selectedInstruments, dataFile.Body)
    } else {
      instrumentUpdates = []
    }

    instrumentUpdates.sort((a, b) => new Date(b.dateTime) - new Date(a.dateTime))
    const html = await renderHtml(instrumentUpdates)
    await uploadInstrumentUpdatesToS3(html)
  } catch (err) {
    winston.error('error occured during instruments saving', err)
    throw err
  }

  winston.info('instrument updates generated')
  return 'instrument updates generated'
}

module.exports = {
  Handler,
}
