#!/usr/bin/env node
// Urza
// ----
// Urza is a framework for rapid node.js development.
// If you'd like to know more about urza, check out the README.md file in this same folder.
// ©2011 Jesse Ditson

if(require.main === module) {
  // Urza was called as a command line script.
  
  // TODO: add support back for create & delete
  
  // Dependencies
  // ------------
  var fs = require('fs'),
      path = require('path'),
      wrench = require('wrench'),
      walk = require('./lib/helpers/walk'),
      mkdirp = require('mkdirp'),
      async = require('async'),
      exec = require('child_process').exec,
      program = require('commander');

  // **Main Urza file. This does all sorts of handy tasks.**

  // Some setup stuff to get ready.
  var version = JSON.parse(fs.readFileSync(__dirname + '/package.json')).version;

  // Command-Line App
  // ----------------

  // Set up our program:
  program.version(version);

  // Urza's Tasks
  // ------------
  
  // init
  require('./cli/init')(program)
  // create
  //require('./cli/create')(program)
  // remove
  //require('./cli/remove')(program)
  // build
  require('./cli/build')(program)
  
  // Start it up
  program.parse(process.argv);
} else {
  // Urza was require()'d.
  
  // Dependencies
  // ------------

  var express = module.exports.express = require('express'),
      fs = require('fs'),
      cluster = require('cluster'),
      _ = require('underscore'),
      path = require('path'),
      gzippo = require('gzippo');

  // Module Dependencies
  // -------------------
  var logger = require('./lib/logging/logger.js'),
      reporter = require('./lib/logging/reporter.js'),
      reqLogger = require('./lib/logging/requestLogger.js'),
      expressHandlebars = require('./lib/helpers/express-handlebars.js'),
      useragent = require('./lib/helpers/middleware/useragent.js'),
      render = require('./lib/helpers/middleware/render.js'),
      viewsMiddleware = require('./lib/helpers/middleware/views.js').middleware,
      Api = require('./lib/api.js');
  // Urza App Class
  // --------------
  var UrzaServer = module.exports.Server = function(options){
    this.options = options;
    this.publicDir = this.options.environment == "development" ? "client" : "public";
    this.api = new Api();
    this.app = this.createApp();
    this.cluster = cluster;
    this.logger = logger;
    this.reporter = reporter;
    this.workers = [];
    this.workerMethods = {};
    if(options.configure){
      options.configure(this.app,this);
    }
    this.addRoutes(this.app);
    // mimic the routing behavior of express.
    var expressMethods = ['get','post','all','use','configure'];
    expressMethods.forEach(function(method){
      this[method] = this.app[method].bind(this.app);
    }.bind(this));
  }

  // **Start Server**
  // starts up the app
  UrzaServer.prototype.start = function(){
    if (this.options.environment=="production") {
      var numCpus = require('os').cpus().length;
      // in production, set up cluster
      if (cluster.isMaster) {
        var numberOfWorkers = numCpus>1 ? numCpus : 2;
        if (!this.options.maxCpus) numberOfWorkers = this.options.maxCpus;
        var forkWorker = function(){
          var worker = cluster.fork();
          this.workers.push(worker);
          // allow communication to this worker
          worker.on('message',function(worker,message){
            if(this.workerMethods[message.method]){
              this.workerMethods[message.method].call(this,message.data)
            } else {
              logger.silly('worker tried to call method ' + message.method + ', but it does not exist. Data: ',message.data)
            }
          }.bind(this,worker))
        }.bind(this)
        for(var i=0; i< numberOfWorkers; i++) {
          forkWorker()
        }
         cluster.on('death', function(worker) {
          forkWorker()
        });
      } else {
        this.app.listen(this.options.serverPort);
        logger.debug("Urza server master started listening on port: " + this.options.serverPort)
      }
    } else {
      // in development, just run as an express instance.
      this.app.listen(this.options.serverPort);
      logger.debug("Urza server started as single process listening on port: " + this.options.serverPort)  
    }
  }

  // **Create App**
  // creates and configures an express app.
  UrzaServer.prototype.createApp = function(){
    var app = express.createServer();
    // **Express app configuration**
    app.configure(function(){
      // basic express stuff
      app.use(express.bodyParser());
      app.use(express.cookieParser());
      // templates
      this.configureTemplates(app);
      // middleware
      app.use(express.methodOverride());
      // user agent
      app.use(useragent);
      // views.js - always compiled at runtime.
      app.use(viewsMiddleware);
      // static files
      var oneYear = 31557600000;
      app.use(gzippo.staticGzip('./' + this.publicDir,{ maxAge: oneYear }));
      app.use(gzippo.staticGzip(__dirname + '/client',{ maxAge: oneYear }));
      if(this.options.sessionHandler){
        app.use(express.session(this.options.sessionHandler));
      } else {
        app.use(express.session({ secret: "aging daddies" }));
      }
      // if authenticate is specified, use the path specified as the authenticate middleware.
      if(this.options.authenticate){
        app.use(require(process.cwd() + '/' + this.options.authenticate).bind(this));
      }
      app.use(render);
      app.use(reqLogger.create(logger));
      app.use(gzippo.compress());
    }.bind(this));
    // set up development only configurations
    app.configure('development', function(){
      // Be as loud as possible during development errors
       app.use(express.errorHandler({ dumpExceptions: true, showStack: true })); 
    });
    // set up production only configurations
    app.configure('production', function(){
      // Be as quiet as possible during production errors
       app.use(express.errorHandler()); 
    });
    // add dynamic helpers
    this.configureHelpers(app);
    // return the ready to .listen() app.
    return app;
  }

  // **Set up dynamic helpers**
  // makes some assumptions about helpers...
  UrzaServer.prototype.configureHelpers = function(app){
    // set up dynamic helpers - these will be available in the layout scope when pages are rendered.
    var cssCache,
        componentPath = process.cwd() + '/client/css/components';
    app.dynamicHelpers({
      user : function(req,res){
        return req.session && req.session.user;
      },
      componentcss : function(req,res){
        if(!cssCache) cssCache = (path.existsSync(componentPath)) ? fs.readdirSync(componentPath) : [];
        return cssCache;
      }
    });
    return app;
  }

  // **Set up Templating Engine**
  // configures the templating engine we want to work with.
  // TODO: may need larger abstraction of view logic.
  UrzaServer.prototype.configureTemplates = function(app){
    if(this.options && this.options.templates && this.options.templates.engine){
      switch(this.options.templates.engine){
        case 'handlebars' :
          // set up view engine
          app.set('view engine','html');
          app.set('views',process.cwd()+ '/client/views');
          app.register('html',expressHandlebars);
          this.templatingEngine = expressHandlebars;
          break;
        default :
          throw new Error('Unknown templating engine specified: "'+this.options.templates.engine+'"');
      }
    } else {
      console.warn('No templating engine specified. No view engine will be used.')
    }
    return app;
  }
  
  // **Call Api Method**
  // directly call the api
  UrzaServer.prototype.callApi = function(params,session,body,callback){
    params = params[0] ? params[0].split('/') : [];
    this.api.route(params,session,body,callback);
  }

  // **Set up Routes**
  // sets up Urza's default routes
  UrzaServer.prototype.addRoutes = function(app){
    // **API Route**
    app.all("/api/*",function(req,res,next){
      this.callApi(req.params,req.session,req.body,function(err,response){
        if(err){
          res.json(err.message,500);
        } else {
          res.json(response);
        }
      });
    }.bind(this));
    //**Partial Route**
    // renders a partial based on an api call
    app.all(/\/partial\/([^\/]+)\/?(.+)?/,function(req,res,next){
      // Note: this is all hacked together because express does not appear to support optional splats.
      // http://stackoverflow.com/questions/10020099/express-js-routing-optional-spat-param
      var params = req.params[1] ? [req.params[1]] : [],
          name = req.params[0];
      if(params.length){
        this.callApi(params,req.session,req.body,function(err,response){
         if(err){
           res.json(err.message,500);
         } else {
           data = {
             data : _.extend(response,req.body),
             layout : false
           };
           logger.info('partial request complete.',req.timer);
           res.render('partials/' + name,data);
         }
        });
      } else {
        res.render('partials/'+name,{layout:false});
      }
    }.bind(this));
    // **View Route**
    // Renders a view
    app.all('/view/:name',function(req,res,next){
      data = {
        data: req.body,
        layout : false
      };
      res.render(req.params.name,data);
    });
    // **Main App Route**
    app.all("/*",function(req,res,next){
      if(this['default']){
        this['default'].call(app,req,res,next);
      } else {
        var params = req.prams && req.params.split('/');
        res.render('main');
      }
    }.bind(this));
    // **404 Error Route**
    // this route always should go last, it will catch errors.
    app.all(/(.*)/,function(req,res){
      // TODO: make this prettier.
      res.send(404);
    });
    return app;
  }
}