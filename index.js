'use strict'

const https = require('https')
const {CognitoIdentity} = require('aws-sdk')
const {verify} = require('jsonwebtoken')
const jwkToPem = require('jwk-to-pem')

const ci = new CognitoIdentity({region: process.env.identity_pool_id.split(':')[0]})

const jwks = {}

const fetchJWKs = (issuer) => {
  const jwkLocation = `${issuer}/.well-known/jwks.json`
  if (!jwks[jwkLocation]) {
    jwks[jwkLocation] = new Promise((resolve, reject) => {
      https.get(jwkLocation, res => {
        try {
          const {statusCode} = res
          if (statusCode !== 200) {
            throw new Error(`Failed to fetch ${jwkLocation}: ${statusCode}!`)
          }
          res.setEncoding('utf8')
          let rawData = ''
          res.on('data', (chunk) => {
            rawData += chunk
          })
          res.on('end', () => {
            const keys = JSON.parse(rawData).keys
            resolve(keys.map(key => Object.assign(
              {},
              key,
              {
                pem: jwkToPem({kty: key.kty, n: key.n, e: key.e})
              }
            )))
          })
        } catch (err) {
          return reject(err)
        } finally {
          res.resume()
        }
      })
    })
  }
  return jwks[jwkLocation]
}

const cognitoIdentities = {}

const getCognitoIdentityForToken = (token, payload) => {
  const {iss, sub} = payload
  if (!cognitoIdentities[sub]) {
    cognitoIdentities[sub] = ci
      .getId({
        IdentityPoolId: process.env.identity_pool_id,
        Logins: {
          [iss.replace(/^https:\/\//, '')]: token
        }
      })
      .promise()
      .then(({IdentityId}) => IdentityId)
  }
  return cognitoIdentities[sub]
}

exports.handler = (event, context, callback) => {
  const bearerToken = event.authorizationToken
  if (!/^Bearer [^ .]+.[^ .]+.[^ ]+$/.test(bearerToken)) {
    // Invalid token format. Expected "Bearer ..."!
    return callback('Unauthorized') // eslint-disable-line standard/no-callback-literal
  }
  const token = bearerToken.split(' ').pop()

  const [header64, payload64] = token.split('.')
  const {kid: tokenKid} = JSON.parse(Buffer.from(header64, 'base64'))
  const {iss, token_use: use} = JSON.parse(Buffer.from(payload64, 'base64'))

  if (iss !== process.env.user_pool_url) {
    // Invalid issuer
    return callback('Unauthorized') // eslint-disable-line standard/no-callback-literal
  }

  if (use !== 'id') {
    // Must provide an "id" token
    return callback('Unauthorized') // eslint-disable-line standard/no-callback-literal
  }

  fetchJWKs(iss)
    .then(jwks => {
      const {pem, alg} = jwks.find(({kid}) => kid === tokenKid)
      if (!pem) {
        throw new Error(`Invalid kid "${tokenKid}"!`)
      }
      return new Promise((resolve, reject) => {
        verify(token, pem, {algorithms: [alg]}, (err, payload) => {
          if (err) return reject(err)
          return resolve(payload)
        })
      })
    })
    .then(payload => getCognitoIdentityForToken(token, payload)
      .then(IdentityId => callback(null, {
        principalId: IdentityId,
        policyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Action: 'execute-api:Invoke',
              Effect: 'Allow',
              Resource: `${event.methodArn.split('/')[0]}/*`
            }
          ]
        },
        context: Object.assign(
          {},
          payload,
          {
            cognitoIdentityId: IdentityId
          }
        )
      })))
    .catch(err => {
      // See https://docs.aws.amazon.com/apigateway/latest/developerguide/use-custom-authorizer.html#api-gateway-custom-authorizer-output
      if (err && (err.name === 'TokenExpiredError' || err.name === 'JsonWebTokenError')) {
        return callback('Unauthorized') // eslint-disable-line standard/no-callback-literal
      }
      console.error(err)
      return callback(`Error: ${JSON.stringify(err)}`) // eslint-disable-line standard/no-callback-literal
    })
}
